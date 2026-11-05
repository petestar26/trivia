import { api, unwrapData } from '@/lib/api';

export async function requestSportsLaunch() {
  const data = unwrapData(
    await api.post<{ url: string; mode: string }>('/sportsbook/launch', {
      mobile: window.matchMedia('(max-width: 767px)').matches,
    })
  );
  const url = new URL(data.url);
  if (data.mode !== 'real-wallet' || url.protocol !== 'https:' || url.username || url.password)
    throw Error('Sports could not be opened safely.');
  return url.href;
}

export function navigateToSportsbook(url: string) {
  // Nocturn Sport sends X-Frame-Options: SAMEORIGIN. Use a top-level page.
  window.location.replace(url);
}
