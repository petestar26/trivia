import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Gift, ArrowRightLeft, Sparkles, X } from 'lucide-react';
import { GIFT_COLLECTION_POLICY, giftAmounts } from '@socialplay/shared';
import type { CollectibleGift, OwnedGift, GiftAction, GiftCollectionSnapshot, GroupMemberInfo } from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { Button } from '@/components/ui/button';
import { GiftArt } from './gift-art';
import { useGiftAction } from './use-gift-action';

type Choice = { kind: GiftAction['kind']; gift: CollectibleGift | OwnedGift };
export function GiftCollection({ groupId, userId, initialRecipient, fromChat = false, groupClosed = false }: { groupId?: string; userId: string; initialRecipient?: string; fromChat?: boolean; groupClosed?: boolean }) {
  const [tab, setTab] = useState<'shop' | 'owned'>('shop'); const [page, setPage] = useState(1);
  const [reviewOpen, setReviewOpen] = useState(true);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [recipientId, setRecipient] = useState(initialRecipient ?? (fromChat ? '' : userId));
  const action = useGiftAction(userId, () => setChoice(null));
  const { attempt, notice } = action;
  const collection = useQuery({ queryKey: ['gift-collection', userId, groupId, page],
    queryFn: () => boundedRequest(async () => unwrapData(await api.get<GiftCollectionSnapshot>('/gift-collection', { groupId, page }))),
    refetchOnWindowFocus: true, refetchInterval: 10000, retry: false });
  useEffect(() => {
    if (collection.data) setPage(current => Math.min(current, Math.max(1, Math.ceil(collection.data.totalOwned / collection.data.pageSize))));
  }, [collection.data]);
  const members = useQuery({ queryKey: ['group-gift-members', groupId, userId],
    queryFn: async () => (await api.getGroupMembers(groupId!)).data as GroupMemberInfo[], retry: false, enabled: !!groupId });
  const pick = (kind: GiftAction['kind'], gift: CollectibleGift | OwnedGift) => {
    if (attempt || (groupClosed && kind !== 'CONVERT')) return;
    setChoice({ kind, gift }); setReviewOpen(true); action.setNotice('');
    setRecipient(initialRecipient ?? (kind === 'SEND' || fromChat ? '' : userId));
  };
  const confirm = () => {
    if (attempt) { action.submit(); return; }
    if (!choice || (groupClosed && choice.kind !== 'CONVERT')) return;
    const common = { policyId: GIFT_COLLECTION_POLICY };
    const body: GiftAction = choice.kind === 'BUY'
      ? { ...common, kind: 'BUY', groupId: groupId ?? null, catalogId: choice.gift.id, recipientId, faceValue: choice.gift.faceValue }
      : choice.kind === 'SEND'
        ? { ...common, kind: 'SEND', groupId: groupId!, itemId: choice.gift.id, recipientId, version: (choice.gift as OwnedGift).version }
        : { ...common, kind: 'CONVERT', itemId: choice.gift.id, version: (choice.gift as OwnedGift).version, faceValue: choice.gift.faceValue };
    action.submit({ key: crypto.randomUUID(), action: body, name: choice.gift.name, emoji: choice.gift.emoji,
      faceValue: choice.gift.faceValue, recipientLabel: recipientId === userId ? 'My collection' : `@${members.data?.find(m => m.user.id === recipientId)?.user.username ?? ''}` });
  };
  const selectedValue = attempt?.faceValue ?? choice?.gift.faceValue;
  const amounts = selectedValue ? giftAmounts(selectedValue) : null;
  const kind = attempt?.action.kind ?? choice?.kind;
  const tooExpensive = kind === 'BUY' && !!collection.data && (amounts?.purchaseTotal ?? 0) > collection.data.balance;
  const title = kind === 'CONVERT' ? 'Convert this gift?' : kind === 'SEND' ? 'Send your gift' : 'Make someone’s day';
  return <section className="space-y-6" aria-label="Gift collection">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-violet-600"><Sparkles size={15}/>Little gestures, big smiles</div>
        <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">The gift collection</h1>
        <p className="mt-2 max-w-lg text-sm text-gray-500">Find a gift, brighten the chat, or keep a favourite for yourself.</p></div>
      <div className="rounded-2xl border border-violet-100 bg-white px-5 py-3 dark:bg-gray-900"><p className="text-xs text-gray-500">Game Points</p><p className="text-2xl font-bold tabular-nums">{collection.data?.balance.toLocaleString() ?? '—'}</p></div>
    </div>
    <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-2xl bg-violet-50 px-4 py-3 text-sm text-violet-900 dark:bg-violet-950 dark:text-violet-100">
      <span>✦ Buy with <strong>0% fee</strong></span><span>♡ Send owned gifts <strong>free</strong></span><span>↔ Convert for <strong>90% back</strong></span>
    </div>
    {groupClosed && <p role="status" className="rounded-xl bg-slate-100 p-4 text-sm dark:bg-slate-800">This room has closed. You can still view or convert your owned gifts. Open an active group to send a gift.</p>}
    {attempt && !reviewOpen && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm"><p>A saved gift request needs confirmation. Your receipt is safe.</p><Button className="mt-2" variant="outline" onClick={() => setReviewOpen(true)}>Resume pending gift</Button></div>}
    {notice && !choice && !attempt && <p role="status" className="rounded-xl border bg-white p-3 text-sm dark:bg-gray-900">{notice}</p>}
    <div className="flex gap-2" role="tablist" aria-label="Gift views">
      <button role="tab" aria-selected={tab === 'shop'} className={`rounded-full px-5 py-2 text-sm font-semibold ${tab === 'shop' ? 'bg-violet-600 text-white' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`} onClick={() => setTab('shop')}>Gift shop</button>
      <button role="tab" aria-selected={tab === 'owned'} className={`rounded-full px-5 py-2 text-sm font-semibold ${tab === 'owned' ? 'bg-violet-600 text-white' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`} onClick={() => setTab('owned')}>My gifts {collection.data ? `(${collection.data.totalOwned})` : ''}</button>
    </div>
    {collection.isLoading ? <p role="status">Loading gifts…</p> : collection.isError ? <div role="alert" className="rounded-xl border p-5"><p>Could not load gifts. Reload to refresh your collection and balance.</p><Button variant="outline" className="mt-3" onClick={() => void collection.refetch()}>Reload gifts</Button></div> : <>
      {tab === 'shop' ? <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">{collection.data?.catalog.map(gift => <button key={gift.id} disabled={!!attempt || groupClosed} aria-label={`Choose ${gift.name}`} onClick={() => pick('BUY', gift)} className="group rounded-2xl border border-gray-200 bg-white p-3 text-left shadow-sm transition hover:border-violet-300 hover:shadow-md focus-visible:outline-violet-600 dark:border-gray-700 dark:bg-gray-900">
        <GiftArt emoji={gift.emoji} theme={gift.theme}/><h2 className="mt-3 font-bold">{gift.name}</h2><p className="mt-1 min-h-[2.5rem] text-xs leading-5 text-gray-500">{gift.description}</p>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-1"><strong className="text-sm">{gift.faceValue.toLocaleString()} points</strong><span className="text-xs text-violet-600">No buy fee</span></div>
      </button>)}</div> : <>
        {!collection.data?.totalOwned ? <div className="rounded-2xl border border-dashed p-10 text-center"><Gift className="mx-auto mb-3 text-violet-400" size={32}/><h2 className="font-bold">Your collection starts here</h2><p className="mt-2 text-sm text-gray-500">Gifts you buy or receive appear here. Keep them, send them, or convert them to points.</p></div>
          : <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">{collection.data.owned.map(gift => <article key={gift.id} className="rounded-2xl border bg-white p-3 dark:bg-gray-900"><GiftArt emoji={gift.emoji} theme={gift.theme}/><h2 className="mt-3 font-bold">{gift.name}</h2><p className="my-2 text-xs text-gray-500">Convert for {giftAmounts(gift.faceValue).conversionReturn} points</p><div className="flex flex-wrap gap-2"><Button size="sm" disabled={!!attempt || !groupId || groupClosed} title={!groupId ? 'Open a group to send this gift' : undefined} onClick={() => pick('SEND', gift)}>Send</Button><Button size="sm" variant="outline" disabled={!!attempt} onClick={() => pick('CONVERT', gift)}>Convert</Button></div></article>)}</div>}
        {collection.data && collection.data.totalOwned > collection.data.pageSize && <div className="flex items-center justify-center gap-4"><Button variant="outline" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous</Button><span className="text-sm">Page {page}</span><Button variant="outline" disabled={page * collection.data.pageSize >= collection.data.totalOwned} onClick={() => setPage(p => p + 1)}>Next</Button></div>}
      </>}
    </>}
    {!groupId && <p className="text-sm text-gray-500">Want to send a gift? <Link className="font-semibold text-violet-600 underline" to="/groups">Open a group chat</Link> and choose its Gifts tab.</p>}
    <p className="flex items-start gap-2 text-xs leading-5 text-gray-500"><ArrowRightLeft size={16} className="mt-0.5 shrink-0"/>Gifts use Game Points. Conversion removes the gift and returns its fixed point value minus a 10% fee. These gifts do not convert to Coins or cash.</p>
    <Dialog.Root open={reviewOpen && (!!choice || !!attempt)} onOpenChange={open => { setReviewOpen(open); if (!open && !attempt) setChoice(null); }}>
      <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-[70] bg-gray-950/45 backdrop-blur-sm"/>
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[70] max-h-[90vh] w-[calc(100%_-_2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl dark:bg-gray-900">
          <Dialog.Title className="text-xl font-bold">{title}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-gray-500">{kind === 'CONVERT' ? 'Review what you receive before removing this gift from your collection.' : 'Choose the recipient and check the details before confirming.'}</Dialog.Description>
          <Dialog.Close className="absolute right-4 top-4 rounded-full p-1 text-gray-500" aria-label="Close gift details"><X size={18}/></Dialog.Close>
          <div className="my-5 flex items-center gap-4 rounded-2xl bg-violet-50 p-4 dark:bg-violet-950"><span className="text-5xl" aria-hidden="true">{attempt?.emoji ?? choice?.gift.emoji}</span><div><h2 className="font-bold">{attempt?.name ?? choice?.gift.name}</h2><p className="text-sm text-gray-500">{selectedValue} Game Point value</p></div></div>
          {kind !== 'CONVERT' && <label className="block text-sm font-medium">Recipient<select aria-label="Gift recipient" className="my-2 block w-full rounded-xl border bg-transparent p-3" value={attempt ? ('recipientId' in attempt.action ? attempt.action.recipientId : userId) : recipientId} disabled={!!attempt || action.isPending} onChange={e => setRecipient(e.target.value)}>
            <option value="">Choose a member</option>{kind === 'BUY' && <option value={userId}>My collection</option>}
            {members.data?.filter(member => member.status === 'ACTIVE' && member.user.id !== userId).map(member => <option key={member.user.id} value={member.user.id}>@{member.user.username}</option>)}
          </select>{attempt && <span className="text-xs text-gray-500">{attempt.recipientLabel}</span>}</label>}
          {amounts && <dl className="my-4 space-y-2 text-sm">
            <div className="flex justify-between"><dt>Gift value</dt><dd>{amounts.faceValue} points</dd></div>
            <div className="flex justify-between"><dt>{kind === 'CONVERT' ? 'Conversion fee (10%)' : kind === 'SEND' ? 'Transfer fee' : 'Purchase fee (0%)'}</dt><dd>{kind === 'CONVERT' ? amounts.conversionFee : 0} points</dd></div>
            <div className="flex justify-between border-t pt-3 text-base font-bold"><dt>{kind === 'CONVERT' ? 'You receive' : 'You pay'}</dt><dd>{kind === 'CONVERT' ? amounts.conversionReturn : kind === 'BUY' ? amounts.purchaseTotal : 0} points</dd></div>
          </dl>}
          {kind === 'BUY' && amounts && <p className="mb-4 text-xs text-gray-500">The owner can later convert this gift for {amounts.conversionReturn} points after the 10% conversion fee. Sending the gift costs nothing extra.</p>}
          {members.isError && kind !== 'CONVERT' && <p role="alert" className="mb-3 text-sm text-red-600">Could not load group members. Reload gifts before sending.</p>}
          {tooExpensive && !attempt && <p role="alert" className="mb-3 text-sm text-amber-700">You need {(amounts?.purchaseTotal ?? 0) - (collection.data?.balance ?? 0)} more Game Points.</p>}
          {notice && <p role="status" className="mb-3 text-sm">{notice}</p>}
          {attempt && <p className="mb-3 text-xs text-gray-500">Your request is saved. Retry it to confirm the outcome without paying twice.</p>}
          <Button className="w-full" disabled={action.isPending || (!attempt && ((groupClosed && kind !== 'CONVERT') || tooExpensive || (kind !== 'CONVERT' && !recipientId) || !collection.data || (kind !== 'CONVERT' && !!groupId && !members.isSuccess)))} onClick={confirm}>
            {action.isPending ? 'Confirming…' : attempt ? 'Retry pending gift' : kind === 'CONVERT' ? 'Confirm conversion' : kind === 'SEND' ? 'Confirm and send gift' : `Confirm purchase · ${amounts?.purchaseTotal ?? 0} points`}
          </Button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </section>;
}
