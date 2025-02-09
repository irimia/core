import Boom from "@hapi/boom";
import Hapi from "@hapi/hapi";
import { Validation } from "@solar-network/crypto";

const name = "hapi-ajv";

// todo: review implementation - still needed?
export const hapiAjv: Hapi.Plugin<any> = {
    name,
    version: "1.0.0",
    register: async (server: Hapi.Server, options: object): Promise<void> => {
        const createErrorResponse = (request, h, errors) => {
            return Boom.badData(errors.map((error) => error.message).join(","));
        };

        server.ext({
            type: "onPreHandler",
            method: (request, h) => {
                const config = request.route.settings.plugins?.[name] ?? {};

                if (config.payloadSchema) {
                    const { error, errors } = Validation.validator.validate(config.payloadSchema, request.payload);

                    if (error) {
                        return createErrorResponse(request, h, errors);
                    }
                }

                if (config.querySchema) {
                    const { error, errors } = Validation.validator.validate(config.querySchema, request.query);

                    if (error) {
                        return createErrorResponse(request, h, errors);
                    }
                }

                return h.continue;
            },
        });
    },
};
