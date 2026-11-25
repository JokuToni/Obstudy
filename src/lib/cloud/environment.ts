import * as publicEnvironment from "$env/static/public";
const configured = Reflect.get(publicEnvironment, "PUBLIC_API_BASE_URL");
export const configuredApiUrl =
    typeof configured === "string" ? configured : null;
