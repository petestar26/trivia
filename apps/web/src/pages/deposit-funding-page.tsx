import {useQuery} from '@tanstack/react-query';
import {useAuth} from '@/providers/auth-provider';
import {api,unwrapData} from '@/lib/api';
import {DepositFundingForm} from './deposit-funding-form';

type FundingTargets={role:'main-admin'|'manager';targets:{id:string;label:string}[]};
export function DepositFundingPage() {
  const {user}=useAuth();
  const query=useQuery({
    queryKey:['payments','deposit-funding-targets',user?.id],
    queryFn:async ({signal})=>unwrapData(await api.get<FundingTargets>('/staff/deposit-funding/targets',undefined,{signal})),
    enabled:!!user?.id,retry:false,staleTime:0,
  });
  return <main>
    <h1>P2P deposit funding</h1>
    {!user || query.isError ? <p role="alert">Funding is unavailable for this account.</p> :
      query.isPending ? <p role="status">Checking staff access…</p> :
      query.data && <DepositFundingForm role={query.data.role} targets={query.data.targets}/>}
  </main>;
}
