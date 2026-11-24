/** Native iOS and the installable web build share the phone study interface. */
export const isIosBuild = import.meta.env.MODE === "ios";
export const isWebBuild = import.meta.env.MODE === "web";
