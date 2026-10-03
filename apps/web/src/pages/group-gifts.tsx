import { useParams } from 'react-router-dom';
import { useAuth } from '@/providers/auth-provider';
import { GroupSocialNav } from '@/components/groups/group-social-nav';
import { GiftCollection } from '@/components/gifts/gift-collection';

export function GroupGiftsPage() {
  const { id } = useParams<{ id: string }>(); const { user } = useAuth();
  return user ? <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
    {id && <GroupSocialNav groupId={id}/>}<GiftCollection key={`${id}:${user.id}`} groupId={id} userId={user.id}/>
  </div> : null;
}
