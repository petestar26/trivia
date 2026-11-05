import { NavLink } from 'react-router-dom';
import { GroupRoundActivity } from './group-round-activity';

export function GroupSocialNav({
  groupId,
  showRoundActivity = true,
  roundOpen = false,
}: {
  groupId: string;
  showRoundActivity?: boolean;
  roundOpen?: boolean;
}) {
  return (
    <div className="space-y-3">
      <nav
        aria-label="Group sections"
        className="grid grid-cols-4 gap-1 sm:flex sm:flex-wrap sm:gap-2"
      >
        {[
          [`/messages/${groupId}`, 'Chat'],
          [`/groups/${groupId}/games`, 'Games'],
          [`/groups/${groupId}/gifts`, 'Gifts'],
          [`/groups/${groupId}`, 'Members'],
        ].map(([to, label]) => (
          <NavLink
            key={to}
            to={to}
            end
            className={({ isActive }) =>
              `rounded-full border px-2 py-2 text-center text-xs font-semibold sm:px-4 sm:text-sm ${isActive || (roundOpen && label === 'Games') ? 'group-nav-active border-emerald-800 bg-emerald-800 text-white' : 'border-gray-200 bg-white text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200'}`
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>
      {showRoundActivity && <GroupRoundActivity groupId={groupId} />}
    </div>
  );
}
