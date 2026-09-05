/** Keep Hub-only MCP clients independent of optional standalone host peers. */
export function createStandaloneHarness(options, { load = () => import('@deepseek-ai/dsh-sdk-client') } = {}) {
  let loading;
  let harness;
  let closed = false;
  return {
    async run(...args) {
      if (closed) throw Error('standalone job cancelled before startup');
      loading ??= load().catch(error => {
        if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'MODULE_NOT_FOUND') throw error;
        throw Object.assign(new Error('Standalone DSH SDK is unavailable. Repair the Crew-owned installation before using standalone mode; Hub mode does not require this SDK.'), { code: 'STANDALONE_SDK_UNAVAILABLE' });
      });
      const { DeepSeekHarness } = await loading;
      if (closed) throw Error('standalone job cancelled before startup');
      harness ??= new DeepSeekHarness(options);
      return harness.run(...args);
    },
    async close() {
      closed = true;
      if (harness) await harness.close();
    },
  };
}
