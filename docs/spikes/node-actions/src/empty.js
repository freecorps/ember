import { serve } from "./_serve.js";
export default serve({ noop: async () => ({ ok: 1 }) });
