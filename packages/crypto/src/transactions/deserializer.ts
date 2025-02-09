import { TransactionType, TransactionTypeGroup } from "../enums";
import {
    DuplicateParticipantInMultiSignatureError,
    InvalidTransactionBytesError,
    TransactionVersionError,
} from "../errors";
import { Address } from "../identities";
import { IDeserializeOptions, ITransaction, ITransactionData } from "../interfaces";
import { configManager } from "../managers";
import { BigNumber, ByteBuffer, isSupportedTransactionVersion } from "../utils";
import { TransactionTypeFactory } from "./types";

// Reference: https://github.com/ArkEcosystem/AIPs/blob/master/AIPS/aip-11.md
export class Deserializer {
    public static applyV1Compatibility(transaction: ITransactionData): void {
        transaction.secondSignature = transaction.secondSignature || transaction.signSignature;
        transaction.typeGroup = TransactionTypeGroup.Core;

        if (transaction.type === TransactionType.Core.Vote && transaction.senderPublicKey) {
            transaction.recipientId = Address.fromPublicKey(transaction.senderPublicKey, transaction.network);
        } else if (
            transaction.type === TransactionType.Core.MultiSignature &&
            transaction.asset &&
            transaction.asset.multiSignatureLegacy
        ) {
            transaction.asset.multiSignatureLegacy.keysgroup = transaction.asset.multiSignatureLegacy.keysgroup.map(
                (k) => (k.startsWith("+") ? k : `+${k}`),
            );
        }
    }

    public static deserialize(serialized: string | Buffer, options: IDeserializeOptions = {}): ITransaction {
        const data = {} as ITransactionData;

        const buff: ByteBuffer = this.getByteBuffer(serialized);
        this.deserializeCommon(data, buff);

        this.burnFee(data);

        const instance: ITransaction = TransactionTypeFactory.create(data);
        this.deserializeVendorField(instance, buff);

        // Deserialize type specific parts
        instance.deserialize(buff);

        this.deserializeSchnorr(data, buff);

        if (data.version) {
            if (
                options.acceptLegacyVersion ||
                options.disableVersionCheck ||
                isSupportedTransactionVersion(data.version)
            ) {
                if (data.version === 1) {
                    this.applyV1Compatibility(data);
                }
            } else {
                throw new TransactionVersionError(data.version);
            }
        }

        instance.serialized = buff.getResult();

        return instance;
    }

    public static deserializeCommon(transaction: ITransactionData, buf: ByteBuffer): void {
        // buf.skip(1); // Skip 0xFF marker
        buf.jump(1); // Skip 0xFF marker
        transaction.version = buf.readUInt8();
        transaction.network = buf.readUInt8();

        if (transaction.version === 1) {
            transaction.type = buf.readUInt8();
            transaction.timestamp = buf.readUInt32LE();
        } else {
            transaction.typeGroup = buf.readUInt32LE();
            transaction.type = buf.readUInt16LE();
            transaction.nonce = BigNumber.make(buf.readBigUInt64LE());
        }

        transaction.senderPublicKey = buf.readBuffer(33).toString("hex");
        transaction.fee = BigNumber.make(buf.readBigUInt64LE().toString());
        transaction.amount = BigNumber.ZERO;
    }

    private static deserializeVendorField(transaction: ITransaction, buf: ByteBuffer): void {
        const vendorFieldLength: number = buf.readUInt8();
        if (vendorFieldLength > 0) {
            if (transaction.hasVendorField()) {
                const vendorFieldBuffer: Buffer = buf.readBuffer(vendorFieldLength);
                transaction.data.vendorField = vendorFieldBuffer.toString("utf8");
            } else {
                buf.jump(vendorFieldLength);
            }
        }
    }

    private static deserializeSchnorr(transaction: ITransactionData, buf: ByteBuffer): void {
        const canReadNonMultiSignature = () => {
            return (
                buf.getRemainderLength() && (buf.getRemainderLength() % 64 === 0 || buf.getRemainderLength() % 65 !== 0)
            );
        };

        if (canReadNonMultiSignature()) {
            transaction.signature = buf.readBuffer(64).toString("hex");
        }

        if (canReadNonMultiSignature()) {
            transaction.secondSignature = buf.readBuffer(64).toString("hex");
        }

        if (buf.getRemainderLength()) {
            if (buf.getRemainderLength() % 65 === 0) {
                transaction.signatures = [];

                const count: number = buf.getRemainderLength() / 65;
                const publicKeyIndexes: { [index: number]: boolean } = {};
                for (let i = 0; i < count; i++) {
                    const multiSignaturePart: string = buf.readBuffer(65).toString("hex");
                    const publicKeyIndex: number = parseInt(multiSignaturePart.slice(0, 2), 16);

                    if (!publicKeyIndexes[publicKeyIndex]) {
                        publicKeyIndexes[publicKeyIndex] = true;
                    } else {
                        throw new DuplicateParticipantInMultiSignatureError();
                    }

                    transaction.signatures.push(multiSignaturePart);
                }
            } else {
                throw new InvalidTransactionBytesError("signature buffer not exhausted");
            }
        }
    }

    private static getByteBuffer(serialized: Buffer | string): ByteBuffer {
        if (!(serialized instanceof Buffer)) {
            serialized = Buffer.from(serialized, "hex");
        }

        return new ByteBuffer(serialized);
    }

    private static burnFee(data: ITransactionData): void {
        const milestone = configManager.getMilestone();
        data.burnedFee = BigNumber.ZERO;
        if (milestone.burnPercentage !== undefined) {
            const burnPercentage = parseInt(milestone.burnPercentage);
            if (burnPercentage >= 0 && burnPercentage <= 100) {
                data.burnedFee = data.fee.minus(data.fee.times(100 - burnPercentage).dividedBy(100));
            }
        }
    }
}
