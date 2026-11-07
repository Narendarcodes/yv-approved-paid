/**
 * Entry point of the Render Workflow service (start command: `npm start`).
 * Importing the flows registers them; the SDK starts its task server on its own
 * when Render sets RENDER_SDK_SOCKET_PATH.
 */
export { advanceClocks, advanceDelivery } from './flows';
