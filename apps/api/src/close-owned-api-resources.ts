type Stop = () => void | Promise<unknown>;

/** Start stopping every producer before awaiting any of them.
 * This does not change payment admission gates; it only closes this process.
 * The caller must arrange a deadline and an HTTP/socket close owner.
 */
export async function closeOwnedApiResources(
  closeIngress: Stop,
  stopBackground: readonly Stop[],
  disconnectDatabase: Stop,
): Promise<void> {
  const invoke = (stop: Stop): Promise<unknown> => {
    try { return Promise.resolve(stop()); }
    catch (error) { return Promise.reject(error); }
  };
  const close = invoke(closeIngress);
  const jobs = stopBackground.map(invoke);
  const stopped = await Promise.allSettled([close, ...jobs]);
  if (stopped.some((result) => result.status === 'rejected')) {
    // Do not disconnect a shared DB client when an ingress or worker drain
    // couldn't be established. Surface only a fixed, non-secret message.
    throw new Error('API resource drain did not complete');
  }
  await disconnectDatabase();
}
