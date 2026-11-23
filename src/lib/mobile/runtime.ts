/** iOS builds select the phone shell; a dev-only browser route supports UI testing. */
export const isIosBuild = import.meta.env.MODE === "ios";
