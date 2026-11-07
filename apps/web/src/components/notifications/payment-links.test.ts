import { expect, it } from 'vitest';
import { toNotificationPage } from './notification-pages';
it('only exposes complete local payment-room links from notification data', () => {
  const valid = '/wallet/orders/withdrawal/11111111-1111-4111-8111-111111111111';
  const urls = [
    valid,
    'https://evil.example/',
    '//evil.example/',
    'javascript:alert(1)',
    valid + '?redirect=https://evil.example/',
    valid + '/../../auth/logout',
    '/wallet/orders/withdrawal/not-an-id',
  ];
  const result = toNotificationPage(
    {
      success: true,
      data: urls.map((url, i) => ({
        id: String(i),
        type: 'SYSTEM',
        title: 'Update',
        body: 'Order message',
        isRead: false,
        createdAt: new Date().toISOString(),
        data: { url },
      })),
    } as any,
    1
  );
  expect(result.items.map((n) => n.paymentUrl)).toEqual([valid, ...Array(6).fill(undefined)]);
});
