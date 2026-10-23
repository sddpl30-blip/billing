import { useState } from 'react';
import { addUser, deactivateUser, listUsers, setRoles, type UserAccount } from '../../../api/office/governance';
import type { OfficeContext } from '../types';
import {
  Badge, Button, Card, FormDialog, LoadState, Table, cellClass, inputClass, labelClass,
  useLoad, useWrite,
} from './ui';

const SEPARATION_HINT =
  'Manager cannot be combined with treasurer or secretary, nor secretary with treasurer: one account would ' +
  'then both make and check the same figures. The server refuses those, and refuses a change to your own roles.';

/** Users and their roles. Every rule about who may hold what is the server's. */
export function UsersSection({ ctx }: { ctx: OfficeContext }) {
  const loaded = useLoad(() => listUsers(ctx.client), [ctx]);
  const { busy, run } = useWrite(ctx, loaded.refresh);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<UserAccount | null>(null);
  const [deactivating, setDeactivating] = useState<UserAccount | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const users = loaded.data?.users ?? [];
  const roles = loaded.data?.availableRoles ?? [];
  const shown = users.filter(u => showInactive || u.active);

  return (
    <Card
      title="Users and roles"
      actions={<Button tone="primary" onClick={() => setAdding(true)} disabled={loaded.data === null}>Add a user</Button>}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--mv-muted)] flex-1 min-w-[200px]">
          Role changes take effect at once. Deactivating an account ends its sessions.
        </p>
        <div className="flex items-center gap-2">
          <input id="gov-users-inactive" type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} className="w-4 h-4 accent-[var(--mv-accent)]" />
          <label htmlFor="gov-users-inactive" className="text-xs text-[var(--mv-ink)]">Show deactivated</label>
        </div>
      </div>
      <LoadState loaded={loaded} empty="No users to show." isEmpty={shown.length === 0} />
      {shown.length > 0 && (
        <Table head={['Account', 'Roles', 'Flats', 'Last sign-in', '']}>
          {shown.map(u => (
            <tr key={u.id} className={u.active ? '' : 'opacity-60'}>
              <td className={`${cellClass} min-w-[200px] break-all`}>
                <span className="font-bold">{u.email}</span>
                {u.ownerName !== null && <span className="block text-[10px] text-[var(--mv-muted)]">{u.ownerName}</span>}
                {!u.active && <span className="block mt-1"><Badge tone="muted">Deactivated</Badge></span>}
              </td>
              <td className={cellClass}>
                <div className="flex flex-wrap gap-1">
                  {u.roles.length === 0 ? <span className="text-[var(--mv-muted)]">none</span> : u.roles.map(r => <Badge key={r} tone="muted">{r}</Badge>)}
                </div>
              </td>
              <td className={cellClass}>{u.flats.length === 0 ? '—' : u.flats.join(', ')}</td>
              <td className={`${cellClass} whitespace-nowrap`}>{u.lastLoginAt === null ? 'never' : u.lastLoginAt.slice(0, 16)}</td>
              <td className={`${cellClass} text-right whitespace-nowrap space-x-2`}>
                {u.active && (
                  <>
                    <Button onClick={() => setEditing(u)} aria-label={`Change roles for ${u.email}`}>Roles</Button>
                    <Button onClick={() => setDeactivating(u)} aria-label={`Deactivate ${u.email}`}>Deactivate</Button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {adding && (
        <AddUserDialog
          roles={roles}
          busy={busy === 'add'}
          onClose={() => setAdding(false)}
          onSubmit={async input => {
            const done = await run('add', () => addUser(ctx.client, input), `${input.email} added.`);
            if (done) setAdding(false);
          }}
        />
      )}
      {editing !== null && (
        <RolesDialog
          user={editing}
          roles={roles}
          busy={busy === 'roles'}
          onClose={() => setEditing(null)}
          onSubmit={async next => {
            const done = await run('roles', () => setRoles(ctx.client, editing.id, next), `Roles for ${editing.email} updated.`);
            if (done) setEditing(null);
          }}
        />
      )}
      {deactivating !== null && (
        <DeactivateDialog
          user={deactivating}
          busy={busy === 'deactivate'}
          onClose={() => setDeactivating(null)}
          onSubmit={async reason => {
            const done = await run(
              'deactivate', () => deactivateUser(ctx.client, deactivating.id, reason),
              result => `${deactivating.email} deactivated; ${String((result as { sessionsRevoked: number }).sessionsRevoked)} session(s) ended.`,
            );
            if (done) setDeactivating(null);
          }}
        />
      )}
    </Card>
  );
}

function RoleChecks({ idPrefix, roles, selected, onChange }: {
  idPrefix: string; roles: readonly string[]; selected: readonly string[]; onChange: (next: string[]) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className={labelClass}>Roles</legend>
      <div className="grid grid-cols-2 gap-2">
        {roles.map(role => (
          <div key={role} className="flex items-center gap-2">
            <input
              id={`${idPrefix}-${role}`}
              type="checkbox"
              checked={selected.includes(role)}
              onChange={e => onChange(e.target.checked ? [...selected, role] : selected.filter(r => r !== role))}
              className="w-4 h-4 accent-[var(--mv-accent)]"
            />
            <label htmlFor={`${idPrefix}-${role}`} className="text-sm text-[var(--mv-ink)]">{role}</label>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-[var(--mv-muted)] leading-relaxed">{SEPARATION_HINT}</p>
    </fieldset>
  );
}

function AddUserDialog({ roles, busy, onClose, onSubmit }: {
  roles: readonly string[]; busy: boolean; onClose: () => void;
  onSubmit: (input: { email: string; roles: string[]; password?: string }) => void;
}) {
  const [email, setEmail] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <FormDialog
      id="gov-add-user"
      title="Add a user"
      intro="Without a password the account signs in by emailed code only."
      submitLabel="Add user"
      busy={busy}
      onClose={onClose}
      onSubmit={() => {
        if (email.trim() === '') { setProblem('Enter an email address.'); return; }
        if (selected.length === 0) { setProblem('Give the account at least one role.'); return; }
        if (password !== '' && password.length < 12) { setProblem('A password is at least 12 characters.'); return; }
        setProblem(null);
        onSubmit({ email: email.trim(), roles: selected, ...(password === '' ? {} : { password }) });
      }}
    >
      <div>
        <label htmlFor="gov-user-email" className={labelClass}>Email</label>
        <input id="gov-user-email" type="email" data-autofocus className={inputClass} value={email}
          onChange={e => setEmail(e.target.value)} autoComplete="off" required />
      </div>
      <RoleChecks idPrefix="gov-user-role" roles={roles} selected={selected} onChange={setSelected} />
      <div>
        <label htmlFor="gov-user-password" className={labelClass}>Password (optional, 12+ characters)</label>
        <input id="gov-user-password" type="password" className={inputClass} value={password}
          onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
      </div>
      {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}
    </FormDialog>
  );
}

function RolesDialog({ user, roles, busy, onClose, onSubmit }: {
  user: UserAccount; roles: readonly string[]; busy: boolean; onClose: () => void;
  onSubmit: (roles: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>([...user.roles]);
  return (
    <FormDialog
      id="gov-user-roles"
      title={`Roles for ${user.email}`}
      submitLabel="Save roles"
      busy={busy}
      onClose={onClose}
      onSubmit={() => onSubmit(selected)}
    >
      <RoleChecks idPrefix="gov-roles" roles={roles} selected={selected} onChange={setSelected} />
    </FormDialog>
  );
}

function DeactivateDialog({ user, busy, onClose, onSubmit }: {
  user: UserAccount; busy: boolean; onClose: () => void; onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <FormDialog
      id="gov-deactivate-user"
      title={`Deactivate ${user.email}`}
      intro="Every session the account has is ended now, and any outstanding sign-in code stops working."
      submitLabel="Deactivate"
      busy={busy}
      onClose={onClose}
      onSubmit={() => {
        if (reason.trim() === '') { setProblem('Say why, for the audit trail.'); return; }
        setProblem(null);
        onSubmit(reason.trim());
      }}
    >
      <div>
        <label htmlFor="gov-deactivate-reason" className={labelClass}>Reason</label>
        <input id="gov-deactivate-reason" data-autofocus className={inputClass} value={reason} maxLength={300}
          onChange={e => setReason(e.target.value)} placeholder="e.g. Left the committee" required />
      </div>
      {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}
    </FormDialog>
  );
}
