import { Container, Contracts, Enums, Providers, Services, Types, Utils } from "@solar-network/core-kernel";
import { Blocks, Crypto, Interfaces, Managers, Transactions, Validation } from "@solar-network/crypto";
import dayjs from "dayjs";
import delay from "delay";

import { constants } from "./constants";
import { SocketErrors } from "./enums";
import { PeerPingTimeoutError, PeerStatusResponseError, PeerVerificationFailedError } from "./errors";
import { PeerVerifier } from "./peer-verifier";
import { RateLimiter } from "./rate-limiter";
import { replySchemas } from "./schemas";
import { getCodec } from "./socket-server/utils/get-codec";
import { buildRateLimiter, isValidVersion } from "./utils";

// todo: review the implementation
@Container.injectable()
export class PeerCommunicator implements Contracts.P2P.PeerCommunicator {
    @Container.inject(Container.Identifiers.Application)
    private readonly app!: Contracts.Kernel.Application;

    @Container.inject(Container.Identifiers.PluginConfiguration)
    @Container.tagged("plugin", "@solar-network/core-p2p")
    private readonly configuration!: Providers.PluginConfiguration;

    @Container.inject(Container.Identifiers.PeerConnector)
    private readonly connector!: Contracts.P2P.PeerConnector;

    @Container.inject(Container.Identifiers.EventDispatcherService)
    private readonly events!: Contracts.Kernel.EventDispatcher;

    @Container.inject(Container.Identifiers.LogService)
    private readonly logger!: Contracts.Kernel.Logger;

    @Container.inject(Container.Identifiers.PeerRepository)
    private readonly repository!: Contracts.P2P.PeerRepository;

    @Container.inject(Container.Identifiers.QueueFactory)
    private readonly createQueue!: Types.QueueFactory;

    @Container.inject(Container.Identifiers.TriggerService)
    private readonly triggers!: Services.Triggers.Triggers;

    @Container.inject(Container.Identifiers.WalletRepository)
    @Container.tagged("state", "blockchain")
    private readonly walletRepository!: Contracts.State.WalletRepository;

    private outgoingRateLimiter!: RateLimiter;

    private postTransactionsQueueByIp: Map<string, Contracts.Kernel.Queue> = new Map();

    @Container.postConstruct()
    public initialize(): void {
        this.outgoingRateLimiter = buildRateLimiter({
            // White listing anybody here means we would not throttle ourselves when sending
            // them requests, ie we could spam them.
            isOutgoing: true,
            whitelist: [],
            remoteAccess: [],
            rateLimit: this.configuration.getOptional<number>("rateLimit", 100),
            rateLimitPostTransactions: this.configuration.getOptional<number>("rateLimitPostTransactions", 25),
        });

        this.events.listen(Enums.PeerEvent.Disconnect, {
            handle: ({ data }) => this.postTransactionsQueueByIp.delete(data.peer.ip),
        });
    }

    public async postBlock(peer: Contracts.P2P.Peer, block: Interfaces.IBlock): Promise<void> {
        const postBlockTimeout = 10000;

        const response = await this.emit(
            peer,
            "p2p.blocks.postBlock",
            {
                block: Blocks.Serializer.serializeWithTransactions({
                    ...block.data,
                    transactions: block.transactions.map((tx) => tx.data),
                }),
            },
            postBlockTimeout,
        );

        if (response && response.height) {
            peer.state.height = response.height;
        }
    }

    public async postTransactions(peer: Contracts.P2P.Peer, transactions: Buffer[]): Promise<void> {
        const postTransactionsTimeout = 10000;
        const postTransactionsRateLimit = this.configuration.getOptional<number>("rateLimitPostTransactions", 25);

        if (!this.postTransactionsQueueByIp.get(peer.ip)) {
            this.postTransactionsQueueByIp.set(peer.ip, await this.createQueue());
        }

        const queue = this.postTransactionsQueueByIp.get(peer.ip)!;
        queue.resume();
        queue.push({
            handle: async () => {
                await this.emit(peer, "p2p.transactions.postTransactions", { transactions }, postTransactionsTimeout);
                await delay(Math.ceil(1000 / postTransactionsRateLimit));
                // to space up between consecutive calls to postTransactions according to rate limit
                // optimized here because default throttling would not be effective for postTransactions
            },
        });
    }

    // ! do not rely on parameter timeoutMsec as guarantee that ping method will resolve within it !
    // ! peerVerifier.checkState can take more time !
    // TODO refactor ?
    public async ping(
        peer: Contracts.P2P.Peer,
        timeoutMsec: number,
        blockTimeLookup: Crypto.GetBlockTimeStampLookup | undefined,
        force = false,
    ): Promise<any> {
        const deadline = new Date().getTime() + timeoutMsec;

        if (peer.isIgnored() || (!peer.stale && peer.recentlyPinged() && !force)) {
            return undefined;
        }

        const getStatusTimeout = timeoutMsec < 5000 ? timeoutMsec : 5000;
        const pingResponse: Contracts.P2P.PeerPingResponse = await this.emit(
            peer,
            "p2p.peer.getStatus",
            {},
            getStatusTimeout,
        );

        if (!pingResponse) {
            throw new PeerStatusResponseError(peer.ip);
        }

        if (process.env.CORE_SKIP_PEER_STATE_VERIFICATION !== "true") {
            if (!this.validatePeerConfig(peer, pingResponse.config)) {
                throw new PeerVerificationFailedError();
            }

            const peerVerifier = this.app.resolve(PeerVerifier).initialize(peer);

            if (deadline <= new Date().getTime()) {
                throw new PeerPingTimeoutError(timeoutMsec);
            }

            peer.verificationResult = await peerVerifier.checkState(pingResponse.state, deadline);

            if (!peer.isVerified()) {
                throw new PeerVerificationFailedError();
            }
        }

        peer.lastPinged = dayjs();
        peer.plugins = pingResponse.config.plugins;
        peer.publicKeys = [];
        peer.stale = false;
        peer.state = pingResponse.state;

        let slotInfo;
        if (blockTimeLookup) {
            slotInfo = Crypto.Slots.getSlotInfo(blockTimeLookup);
            if (slotInfo.slotNumber < 0 && pingResponse.state.currentSlot) {
                pingResponse.state.currentSlot = pingResponse.state.currentSlot >> 0;
            }
            const stateBuffer = Buffer.from(
                Utils.stringify({ state: pingResponse.state, config: pingResponse.config }),
            );
            const alreadyCheckedSignatures: string[] = [];
            const lastBlock: Interfaces.IBlock = this.app
                .get<Contracts.State.StateStore>(Container.Identifiers.StateStore)
                .getLastBlock();
            const height = lastBlock.data.height + 1;
            const roundInfo = Utils.roundCalculator.calculateRound(height);
            const delegates: (string | undefined)[] = (
                (await this.triggers.call("getActiveDelegates", {
                    roundInfo,
                })) as Contracts.State.Wallet[]
            ).map((wallet) => wallet.getPublicKey());
            for (const signatureIndex in pingResponse.signatures) {
                const publicKey = pingResponse.publicKeys![signatureIndex];
                const signature = pingResponse.signatures[signatureIndex];
                const delegatePeer = this.repository
                    .getPeers()
                    .find((otherPeer) => peer.ip !== otherPeer.ip && otherPeer.publicKeys.includes(publicKey));
                if (
                    !alreadyCheckedSignatures.includes(publicKey + signature) &&
                    pingResponse.state &&
                    pingResponse.state.currentSlot
                ) {
                    if (
                        pingResponse.state.currentSlot === slotInfo.slotNumber - 1 ||
                        pingResponse.state.currentSlot === slotInfo.slotNumber ||
                        pingResponse.state.currentSlot === slotInfo.slotNumber + 1
                    ) {
                        if (
                            !delegates.includes(publicKey) ||
                            !Crypto.Hash.verifySchnorr(stateBuffer, signature, publicKey)
                        ) {
                            break;
                        }
                        const delegateWallet = this.walletRepository.findByPublicKey(publicKey);

                        if (!delegatePeer) {
                            peer.publicKeys.push(publicKey);
                            delegateWallet.setAttribute("delegate.version", pingResponse.config.version);
                        } else if (!peer.isForked()) {
                            if (
                                delegatePeer.isForked() ||
                                (peer.state.header.height === lastBlock.data.height &&
                                    peer.state.header.id === lastBlock.data.id) ||
                                (peer.state.header.height >= delegatePeer.state.header.height &&
                                    delegatePeer.state.header.id !== lastBlock.data.id)
                            ) {
                                peer.publicKeys.push(publicKey);
                                delegateWallet.setAttribute("delegate.version", pingResponse.config.version);
                                delegatePeer.publicKeys = delegatePeer.publicKeys.filter(
                                    (peerPublicKey) => peerPublicKey !== publicKey,
                                );
                            }
                        }
                        alreadyCheckedSignatures.push(publicKey + signature);
                    }
                }
            }
        }

        if (peer.plugins["@solar-network/core-api"]) {
            peer.plugins["@arkecosystem/core-api"] = peer.plugins["@solar-network/core-api"];
        }

        return pingResponse.state;
    }

    public async pingPorts(peer: Contracts.P2P.Peer): Promise<void> {
        await Promise.all(
            Object.entries(peer.plugins).map(async ([name, plugin]) => {
                peer.ports[name] = -1;
                try {
                    const { statusCode } = await Utils.http.head(`http://${peer.ip}:${plugin.port}/`);

                    if (statusCode === 200) {
                        peer.ports[name] = plugin.port;
                    }
                } catch {}
            }),
        );
    }

    public async getPeers(peer: Contracts.P2P.Peer): Promise<Contracts.P2P.PeerBroadcast[]> {
        this.logger.debug(`Fetching a fresh peer list from ${peer.url}`);

        const getPeersTimeout = 5000;
        return this.emit(peer, "p2p.peer.getPeers", {}, getPeersTimeout);
    }

    public async hasCommonBlocks(peer: Contracts.P2P.Peer, ids: string[], timeoutMsec?: number): Promise<any> {
        const getCommonBlocksTimeout = timeoutMsec && timeoutMsec < 5000 ? timeoutMsec : 5000;
        const body: any = await this.emit(peer, "p2p.peer.getCommonBlocks", { ids }, getCommonBlocksTimeout);

        if (!body || !body.common) {
            return false;
        }

        return body.common;
    }

    public async getPeerBlocks(
        peer: Contracts.P2P.Peer,
        {
            fromBlockHeight,
            blockLimit = constants.MAX_DOWNLOAD_BLOCKS,
            headersOnly,
            silent = false,
            timeout,
        }: { fromBlockHeight: number; blockLimit?: number; headersOnly?: boolean; silent?: boolean; timeout?: number },
    ): Promise<Interfaces.IBlockData[]> {
        const maxPayload = headersOnly ? blockLimit * constants.KILOBYTE : constants.DEFAULT_MAX_PAYLOAD;

        const peerBlocks = await this.emit(
            peer,
            "p2p.blocks.getBlocks",
            {
                lastBlockHeight: fromBlockHeight,
                blockLimit,
                headersOnly,
                serialized: true,
            },
            timeout ? timeout : this.configuration.getRequired<number>("getBlocksTimeout"),
            maxPayload,
            false,
        );

        if (!peerBlocks || !peerBlocks.length) {
            if (!silent) {
                this.logger.debug(
                    `Peer ${
                        peer.ip
                    } did not return any blocks via height ${fromBlockHeight.toLocaleString()} :see_no_evil:`,
                );
            }
            return [];
        }

        for (const block of peerBlocks) {
            block.ip = peer.ip;

            if (headersOnly) {
                // with headersOnly we still get block.transactions as empty array (protobuf deser) but in this case we actually
                // don't want the transactions as a property at all (because it would make validation fail)
                delete block.transactions;
                continue;
            }

            block.transactions = block.transactions.map((transaction) => {
                const { data } = Transactions.TransactionFactory.fromBytesUnsafe(Buffer.from(transaction, "hex"));
                data.blockId = block.id;
                return data;
            });
        }

        return peerBlocks;
    }

    private validatePeerConfig(peer: Contracts.P2P.Peer, config: Contracts.P2P.PeerConfig): boolean {
        if (config.network.nethash !== Managers.configManager.get("network.nethash")) {
            return false;
        }

        peer.version = config.version;

        if (!isValidVersion(this.app, peer)) {
            return false;
        }

        return true;
    }

    private validateReply(peer: Contracts.P2P.Peer, reply: any, endpoint: string): boolean {
        const schema = replySchemas[endpoint];
        if (schema === undefined) {
            this.logger.error(
                `Cannot validate reply from "${endpoint}": none of the predefined schemas matches :bangbang:`,
            );
            return false;
        }

        const { error } = Validation.validator.validate(schema, reply);
        if (error) {
            /* istanbul ignore else */
            if (process.env.CORE_P2P_PEER_VERIFIER_DEBUG_EXTRA) {
                this.logger.debug(`Got unexpected reply from ${peer.url}/${endpoint}: ${error}`);
            }

            return false;
        }

        return true;
    }

    private async emit(
        peer: Contracts.P2P.Peer,
        event: string,
        payload: any,
        timeout?: number,
        maxPayload?: number,
        disconnectOnError: boolean = true,
    ) {
        await this.throttle(peer, event);

        const codec = getCodec(this.app, event);

        let response;
        let parsedResponsePayload;
        try {
            this.connector.forgetError(peer);

            const timeBeforeSocketCall: number = new Date().getTime();

            maxPayload = maxPayload || constants.DEFAULT_MAX_PAYLOAD_CLIENT;
            await this.connector.connect(peer, maxPayload);

            response = await this.connector.emit(
                peer,
                event,
                codec.request.serialize({
                    ...payload,
                    headers: {
                        version: this.app.version(),
                    },
                }),
                timeout,
            );
            parsedResponsePayload = codec.response.deserialize(response.payload);

            peer.sequentialErrorCounter = 0; // reset counter if response is successful, keep it after emit

            peer.latency = new Date().getTime() - timeBeforeSocketCall;

            if (!this.validateReply(peer, parsedResponsePayload, event)) {
                const validationError = new Error(
                    `Response validation failed from peer ${peer.ip} : ${JSON.stringify(parsedResponsePayload)}`,
                );
                validationError.name = SocketErrors.Validation;
                throw validationError;
            }
        } catch (e) {
            this.handleSocketError(peer, event, e, disconnectOnError);
            return undefined;
        }

        return parsedResponsePayload;
    }

    private async throttle(peer: Contracts.P2P.Peer, event: string): Promise<void> {
        const msBeforeReCheck = 1000;
        while (await this.outgoingRateLimiter.hasExceededRateLimitNoConsume(peer.ip, event)) {
            await delay(msBeforeReCheck);
        }
        try {
            await this.outgoingRateLimiter.consume(peer.ip, event);
        } catch {
            //@ts-ignore
        }
    }

    private handleSocketError(peer: Contracts.P2P.Peer, event: string, error: Error, disconnect: boolean = true): void {
        if (!error.name) {
            return;
        }

        this.connector.setError(peer, error.name);
        peer.sequentialErrorCounter++;
        if (peer.sequentialErrorCounter >= this.configuration.getRequired<number>("maxPeerSequentialErrors")) {
            this.events.dispatch(Enums.PeerEvent.Disconnect, { peer });
        }

        switch (error.name) {
            case SocketErrors.Validation:
                this.logger.debug(`Socket data validation error (peer ${peer.ip}) : ${error.message} :warning:`);
                break;
            case "Error":
                /* istanbul ignore else */
                if (process.env.CORE_P2P_PEER_VERIFIER_DEBUG_EXTRA) {
                    this.logger.debug(`Response error (peer ${peer.ip}/${event}) : ${error.message} :warning:`);
                }
                break;
            default:
                /* istanbul ignore else */
                if (process.env.CORE_P2P_PEER_VERIFIER_DEBUG_EXTRA) {
                    this.logger.debug(`Socket error (peer ${peer.ip}) : ${error.message} :warning:`);
                }
                /* istanbul ignore else */
                if (disconnect) {
                    this.events.dispatch(Enums.PeerEvent.Disconnect, { peer });
                }
        }
    }
}
