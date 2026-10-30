import { useState } from 'react';
import {
  addUser, changeUserEmail, deactivateUser, listUsers, sendQueuedNow, sendWelcome, setRoles, setUserPassword,
  type UserAccount,
} from '../../../api/office/governance';
import type { OfficeContext } from '../types';
import {
  Badge, Button, Card, FormDialog, LoadState, Table, cellClass, inputClass, labelClass,
  useLoad, useWrite,
} from './ui';

const SEPARATION_HINT =
  'Manager cannot be combined with treasurer or secretary, nor secretary with treasurer: one account would ' +
  'then both make and check the same figures. The server refuses those, and refuses a change to your own roles.';

/**
 * Only a resident's e-mail and password are the office's to change. An
 * office-bearer's are not: a secretary who could set the treasurer's password
 * could sign in as the treasurer and approve their own figures.
 */
const isResidentOnly = (u: UserAccount): boolean =>
  u.roles.length > 0 && u.roles.every(r => r === 'resident');

/** Users and their roles. Every rule about who may hold what is the server's. */
export function UsersSection({ ctx }: { ctx: OfficeContext }) {
  const loaded = useLoad(() => listUsers(ctx.client), [ctx]);
  const { busy, run } = useWrite(ctx, loaded.refresh);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<UserAccount | null>(null);
  const [deactivating, setDeactivating] = useState<UserAccount | null>(null);
  const [emailing, setEmailing] = useState<UserAccount | null>(null);
  const [resetting, setResetting] = useState<UserAccount | null>(null);
  const [sending, setSending] = useState<string | null>(null);

  /** Queues welcome e-mails, then sends them in batches with progress in the toast. */
  const welcome = async (userIds?: string[]) => {
    if (userIds === undefined && !window.confirm(
      'Send a welcome e-mail to every resident who has not signed in yet and has not had one?',
    )) return;
    setSending('Queuing…');
    try {
      const queued = await sendWelcome(ctx.client, userIds);
      ctx.toast(queued.note, 'info');
      if (queued.queued > 0 && queued.emailDelivers) {
        const result = await sendQueuedNow(ctx.client, (sent, remaining) =>
          setSending(`Sending… ${sent} sent, ${remaining} to go`));
        ctx.toast(
          `${result.sent} e-mail${result.sent === 1 ? '' : 's'} sent` +
          (result.failed > 0 ? `, ${result.failed} failed (see the log)` : '') +
          (result.remaining !== null && result.remaining > 0 ? `; ${result.remaining} left for the 6 am run.` : '.'),
          result.failed > 0 ? 'error' : 'info',
        );
      }
      await loaded.refresh();
    } catch (err) {
      ctx.toast(err instanceof Error ? err.message : 'The welcome e-mails could not be sent.', 'error');
    } finally {
      setSending(null);
    }
  };
  const [showInactive, setShowInactive] = useState(false);
  const users = loaded.data?.users ?? [];
  const roles = loaded.data?.availableRoles ?? [];
  const shown = users.filter(u => showInactive || u.active);

  return (
    <Card
      title="Users and roles"
      actions={(
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => { void welcome(); }} disabled={loaded.data === null || sending !== null}>
            {sending ?? 'Send welcome e-mails'}
          </Button>
          <Button tone="primary" onClick={() => setAdding(true)} disabled={loaded.data === null}>Add a user</Button>
        </div>
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--mv-muted)] flex-1 min-w-[200px]">
          Role changes take effect at once. Deactivating an account ends its sessions. For a resident whose
          e-mail is not a Google account, change the e-mail or set a password here; office-bearers change their own.
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
                {u.active && u.lastLoginAt === null && (
                  <span className="block text-[10px] text-[var(--mv-muted)] mt-0.5 break-normal">
                    {u.welcomedAt ? `Welcomed ${u.welcomedAt.slice(0, 10)}, not signed in yet` : 'Not signed in yet'}
                  </span>
                )}
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
                    {isResidentOnly(u) && (
                      <>
                        <Button onClick={() => { void welcome([u.id]); }} disabled={sending !== null}
                          aria-label={`Send a welcome e-mail to ${u.email}`}>Welcome</Button>
                        <Button onClick={() => setEmailing(u)} aria-label={`Change e-mail for ${u.email}`}>E-mail</Button>
                        <Button onClick={() => setResetting(u)} aria-label={`Set password for ${u.email}`}>
                          {u.hasPassword ? 'Reset password' : 'Set password'}
                        </Button>
                      </>
                    )}
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
            if (done) {
              setAdding(false);
              if (input.sendWelcome === true) void sendQueuedNow(ctx.client).catch(() => undefined);
            }
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
      {emailing !== null && (
        <EmailDialog
          user={emailing}
          busy={busy === 'email'}
          onClose={() => setEmailing(null)}
          onSubmit={async email => {
            const done = await run(
              'email', () => changeUserEmail(ctx.client, emailing.id, email),
              result => (result as { ownerEmailUpdated: boolean }).ownerEmailUpdated
                ? `Sign-in e-mail changed to ${email}; bills and notices now go there too.`
                : `Sign-in e-mail changed to ${email}. The owner record's e-mail was different and is unchanged.`,
            );
            if (done) setEmailing(null);
          }}
        />
      )}
      {resetting !== null && (
        <PasswordDialog
          user={resetting}
          busy={busy === 'password'}
          onClose={() => setResetting(null)}
          onSubmit={async password => {
            const done = await run(
              'password', () => setUserPassword(ctx.client, resetting.id, password),
              result => `Password set for ${resetting.email}; ${String((result as { sessionsRevoked: number }).sessionsRevoked)} session(s) ended. Give it to them in person, not by e-mail.`,
            );
            if (done) setResetting(null);
          }}
        />
      )}
    </Card>
  );
}

function EmailDialog({ user, busy, onClose, onSubmit }: {
  user: UserAccount; busy: boolean; onClose: () => void; onSubmit: (email: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <FormDialog
      id="gov-user-email-change"
      title={`Change e-mail for ${user.email}`}
      intro="The member signs in with the new address from now on (with Google, if it is a Google account). If the owner record had the same address, bills and notices move to the new one too."
      submitLabel="Change e-mail"
      busy={busy}
      onClose={onClose}
      onSubmit={() => {
        const next = email.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) { setProblem('Enter an e-mail address.'); return; }
        if (next.toLowerCase() === user.email.toLowerCase()) { setProblem('That is already the address.'); return; }
        setProblem(null);
        onSubmit(next);
      }}
    >
      <div>
        <label htmlFor="gov-user-new-email" className={labelClass}>New e-mail</label>
        <input id="gov-user-new-email" type="email" data-autofocus className={inputClass} value={email}
          onChange={e => setEmail(e.target.value)} autoComplete="off" required />
      </div>
      {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}
    </FormDialog>
  );
}

function PasswordDialog({ user, busy, onClose, onSubmit }: {
  user: UserAccount; busy: boolean; onClose: () => void; onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <FormDialog
      id="gov-user-password-set"
      title={`${user.hasPassword ? 'Reset' : 'Set'} password for ${user.email}`}
      intro="Every session the account has ends now. The member can then sign in with this password; they can still use Google if their e-mail is a Google account."
      submitLabel="Set password"
      busy={busy}
      onClose={onClose}
      onSubmit={() => {
        if (password.length < 12) { setProblem('A password is at least 12 characters.'); return; }
        if (password !== again) { setProblem('The two entries do not match.'); return; }
        setProblem(null);
        onSubmit(password);
      }}
    >
      <div>
        <label htmlFor="gov-user-set-password" className={labelClass}>New password (12+ characters)</label>
        <input id="gov-user-set-password" type="password" data-autofocus className={inputClass} value={password}
          onChange={e => setPassword(e.target.value)} autoComplete="new-password" required />
      </div>
      <div>
        <label htmlFor="gov-user-set-password-again" className={labelClass}>Again</label>
        <input id="gov-user-set-password-again" type="password" className={inputClass} value={again}
          onChange={e => setAgain(e.target.value)} autoComplete="new-password" required />
      </div>
      {problem !== null && <p role="alert" className="text-xs text-red-700">{problem}</p>}
    </FormDialog>
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
  onSubmit: (input: { email: string; roles: string[]; password?: string; sendWelcome?: boolean }) => void;
}) {
  const [email, setEmail] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [password, setPassword] = useState('');
  const [welcomeIt, setWelcomeIt] = useState(true);
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
        onSubmit({
          email: email.trim(), roles: selected, ...(password === '' ? {} : { password }),
          ...(welcomeIt ? { sendWelcome: true } : {}),
        });
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
      <div className="flex items-center gap-2">
        <input id="gov-user-welcome" type="checkbox" checked={welcomeIt} onChange={e => setWelcomeIt(e.target.checked)}
          className="w-4 h-4 accent-[var(--mv-accent)]" />
        <label htmlFor="gov-user-welcome" className="text-sm text-[var(--mv-ink)]">Send a welcome e-mail (how to sign in; never the password)</label>
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
