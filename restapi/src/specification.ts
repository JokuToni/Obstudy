import { z } from "zod";
import {
    credentialsSchema,
    passwordSchema,
    deleteAccountSchema,
    syncSchema,
    uploadSchema,
} from "./schemas.js";

function operation(summary: string, schema?: z.ZodType, publicRoute = false) {
    return {
        summary,
        security: publicRoute ? [] : [{ bearerAuth: [] }],
        ...(schema
            ? {
                  requestBody: {
                      required: true,
                      content: {
                          "application/json": {
                              schema: z.toJSONSchema(schema, {
                                  target: "openapi-3.0",
                                  unrepresentable: "any",
                              }),
                          },
                      },
                  },
              }
            : {}),
        responses: {
            "200": {
                description:
                    "Successful response; see docs/restapi.md for response shapes.",
            },
            "201": { description: "Account created and session issued." },
            "403": { description: "Registration disabled or device mismatch." },
            "404": { description: "Resource not found." },
            "429": { description: "Rate limit exceeded." },
            "503": { description: "Database unavailable." },
            "204": {
                description: "Successful operation without a response body.",
            },
            "400": { description: "Invalid payload" },
            "401": { description: "Missing, expired, or revoked session" },
            "409": { description: "Conflicting revision or identity" },
        },
    };
}
export const apiSpecification = {
    openapi: "3.0.3",
    info: { title: "Obstudy API", version: "1.0.0" },
    components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
    paths: {
        "/health": { get: operation("Process liveness", undefined, true) },
        "/ready": { get: operation("Database readiness", undefined, true) },
        "/v1/auth/register": {
            post: operation(
                "Register and issue a device session",
                credentialsSchema,
                true,
            ),
        },
        "/v1/auth/login": {
            post: operation(
                "Log in and issue a device session",
                credentialsSchema,
                true,
            ),
        },
        "/v1/auth/logout": { post: operation("Revoke current session") },
        "/v1/auth/password": {
            post: operation(
                "Change password and revoke all sessions",
                passwordSchema,
            ),
        },
        "/v1/me": {
            get: operation("Current user"),
            delete: operation(
                "Permanently delete account and data",
                deleteAccountSchema,
            ),
        },
        "/v1/devices": { get: operation("List devices") },
        "/v1/devices/{id}": {
            delete: {
                ...operation("Revoke a device and its sessions"),
                parameters: [
                    {
                        in: "path",
                        name: "id",
                        required: true,
                        schema: { type: "string" },
                    },
                ],
            },
        },
        "/v1/library": {
            get: operation("Download current library and schedules"),
            put: operation(
                "Publish library using optimistic revision check",
                uploadSchema,
            ),
        },
        "/v1/sync": {
            post: operation(
                "Exchange durable events and canonical schedules",
                syncSchema,
            ),
        },
        ...Object.fromEntries(
            ["answers", "reviews"].map((name) => [
                `/v1/${name}`,
                {
                    get: {
                        ...operation(`Read paginated ${name}`),
                        parameters: [
                            {
                                in: "query",
                                name: "after",
                                schema: { type: "string" },
                            },
                            {
                                in: "query",
                                name: "limit",
                                schema: {
                                    type: "integer",
                                    minimum: 1,
                                    maximum: 500,
                                },
                            },
                        ],
                    },
                },
            ]),
        ),
    },
};
