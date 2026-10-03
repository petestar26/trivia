import { NavLink } from 'react-router-dom';
export function GroupSocialNav({groupId}:{groupId:string}) {
  return <nav aria-label="Group sections" className="flex flex-wrap gap-2">
    {[[`/messages/${groupId}`,'Chat'],[`/groups/${groupId}/games`,'Games'],[`/groups/${groupId}/gifts`,'Gifts'],[`/groups/${groupId}`,'Members']].map(([to,label])=>
      <NavLink key={to} to={to} end className={({isActive})=>`rounded-full border px-4 py-2 text-sm font-semibold ${isActive?'border-emerald-800 bg-emerald-800 text-white':'border-gray-200 bg-white text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200'}`}>{label}</NavLink>)}
  </nav>;
}
