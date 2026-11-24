import { cloudRequest } from "./client";
import type { MobileSyncTransport } from "../mobile/types";
import type { CloudExchange } from "./types";
export const httpSyncTransport: MobileSyncTransport = {
    exchange: (request) =>
        cloudRequest<CloudExchange>("/v1/sync", "POST", request),
};
