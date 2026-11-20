import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { PaymentRequirementsPage } from './payment-requirements';
it('shows operational ETB floors and separate crypto/provider limitations without promising unlimited stakes', () => {
  render(<MemoryRouter><PaymentRequirementsPage /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Payment requirements' })).toBeInTheDocument();
  expect(screen.getByText('100 ETB')).toBeInTheDocument(); expect(screen.getByText('500 ETB')).toBeInTheDocument();
  expect(screen.getByText(/Existing orders and accepted quotes/)).toBeInTheDocument();
  expect(screen.getByText(/Crypto uses its own/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Support' })).toHaveAttribute('href', '/support');
});
