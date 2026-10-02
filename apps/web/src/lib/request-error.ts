export function requestStatus(error: unknown): number {
  if (!(error instanceof Error)) return 0;
  try {
    const value = JSON.parse(error.message);
    return typeof value.status === 'number' ? value.status : 0;
  } catch {
    return 0;
  }
}
