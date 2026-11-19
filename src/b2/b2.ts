// ═══════════════════════════════════════════════════════════
// WeildBuild B2 → BRIDGE shim
// ═══════════════════════════════════════════════════════════
// Same exported surface the routes already import, but every call
// is relayed to the laptop's local storage folder. Roll back: git revert.
import { bridgeB2 } from "../bridge/render-bridge";

export const isB2Configured = bridgeB2.isB2Configured;
export const uploadObject = bridgeB2.uploadObject;
export const uploadBackup = bridgeB2.uploadBackup;
export const uploadReportAttachment = bridgeB2.uploadReportAttachment;
export const getObject = bridgeB2.getObject;
