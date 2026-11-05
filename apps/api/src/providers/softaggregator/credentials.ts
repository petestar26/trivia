/** Provider-issued credentials may acquire line breaks when pasted into server settings. */
export function providerCredentials(env: Record<string, string | undefined>) {
  return {
    apiLogin: (env.SOFTAGGREGATOR_API_LOGIN ?? '').trim(),
    apiPassword: (env.SOFTAGGREGATOR_API_PASSWORD ?? '').trim(),
  };
}
