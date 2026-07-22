/**
 * The email channel (WATCHTOWER.md §2.2): nodemailer over the instance's
 * configured SMTP relay (or a user's personal SMTP override). 10s
 * connect/greeting, 30s socket timeouts. Bad host/auth -> non-retryable;
 * timeout/5xx -> retryable.
 */
import nodemailer from 'nodemailer';
import { renderEmail } from '../queue/render.js';
import { getUserChannelConfig, getInstanceMeta, getInstanceSecret, getNotifyOrigin } from '../config/channelConfig.js';
import { decryptSecret } from '../config/secrets.js';
import type { ChannelSendResult, NotificationChannelPlugin, NotificationPayload } from '../types.js';

interface EmailUserConfig {
	address?: string;
	smtp?: { host: string; port: number; user?: string; passEnc?: string; tls?: 'starttls' | 'tls' | 'none' };
}

const CONNECT_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 30_000;

export interface EmailTransporter {
	sendMail(opts: { from: string; to: string; subject: string; html: string; text: string }): Promise<unknown>;
}

/** Test seam: the real factory calls nodemailer.createTransport(); tests
 *  override this to avoid a real SMTP connection. */
let transporterFactory: (opts: Record<string, unknown>) => EmailTransporter = (opts) =>
	nodemailer.createTransport(opts) as unknown as EmailTransporter;

export function __setTransporterFactoryForTests(fn: typeof transporterFactory): void {
	transporterFactory = fn;
}
export function __resetTransporterFactoryForTests(): void {
	transporterFactory = (opts) => nodemailer.createTransport(opts) as unknown as EmailTransporter;
}

function config(userId: number): EmailUserConfig | null {
	return getUserChannelConfig(userId, 'email') as EmailUserConfig | null;
}

interface ResolvedSmtp {
	host: string;
	port: number;
	user?: string;
	pass?: string;
	from: string;
	secure: boolean;
	requireTLS: boolean;
}

function resolveSmtp(cfg: EmailUserConfig): ResolvedSmtp | null {
	if (cfg.smtp?.host) {
		// bug fix (hearth-skg.11): `decryptUserSecretField(userId,'email','smtp')`
		// looked up a top-level `smtp` field, but the encrypted value actually
		// lives one level deeper at `smtp.passEnc` -- that field-name mismatch
		// meant a personal SMTP relay's password was NEVER decrypted (always
		// undefined), silently sending auth-less and failing at the SMTP
		// server. Decrypt the envelope directly; fail closed (undefined) on
		// a decrypt error, same posture as every other secret read here.
		let pass: string | undefined;
		if (cfg.smtp.passEnc) {
			try {
				pass = decryptSecret(cfg.smtp.passEnc);
			} catch {
				pass = undefined;
			}
		}
		const tls = cfg.smtp.tls ?? 'starttls';
		return {
			host: cfg.smtp.host,
			port: cfg.smtp.port,
			user: cfg.smtp.user,
			pass,
			from: cfg.address ?? cfg.smtp.user ?? '',
			secure: tls === 'tls',
			requireTLS: tls === 'starttls'
		};
	}
	const host = getInstanceMeta('smtp_host');
	if (!host) return null;
	const port = Number(getInstanceMeta('smtp_port') ?? '587');
	const user = getInstanceMeta('smtp_user') ?? undefined;
	const from = getInstanceMeta('smtp_from') ?? user ?? '';
	const tls = (getInstanceMeta('smtp_tls') as 'starttls' | 'tls' | 'none' | null) ?? 'starttls';
	const pass = getInstanceSecret('smtp_pass') ?? undefined;
	return { host, port, user, pass, from, secure: tls === 'tls', requireTLS: tls === 'starttls' };
}

async function sendTo(userId: number, payload: NotificationPayload): Promise<ChannelSendResult> {
	const cfg = config(userId);
	if (!cfg?.address) return { ok: false, retryable: false, error: 'no destination email address configured' };
	const smtp = resolveSmtp(cfg);
	if (!smtp) return { ok: false, retryable: false, error: 'no SMTP relay configured on this instance' };

	const pgpOn = false; // PGP body encryption is a documented follow-up (not yet implemented)
	const rendered = renderEmail(payload, getNotifyOrigin(), pgpOn);

	try {
		const transporter = transporterFactory({
			host: smtp.host,
			port: smtp.port,
			secure: smtp.secure,
			requireTLS: smtp.requireTLS,
			auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
			connectionTimeout: CONNECT_TIMEOUT_MS,
			greetingTimeout: GREETING_TIMEOUT_MS,
			socketTimeout: SOCKET_TIMEOUT_MS
		});
		await transporter.sendMail({
			from: smtp.from,
			to: cfg.address,
			subject: rendered.subject,
			html: rendered.html,
			text: rendered.text
		});
		return { ok: true };
	} catch (e) {
		const message = String(e);
		// Auth/host errors are config problems (never retryable); everything
		// else (timeout, connection refused, 4xx/5xx SMTP replies) is transient.
		const nonRetryable = /auth|invalid login|enotfound|getaddrinfo|Unknown host/i.test(message);
		return { ok: false, retryable: !nonRetryable, error: message };
	}
}

export const email: NotificationChannelPlugin = {
	id: 'email',
	label: 'Email',
	send: sendTo,
	async test(userId) {
		return sendTo(userId, {
			type: 'tx_received',
			userId,
			level: 'info',
			title: 'Hearth test notification',
			body: 'This is a test notification from your Hearth watchtower.'
		});
	},
	isConfigured(userId) {
		const cfg = config(userId);
		if (!cfg?.address) return false;
		return resolveSmtp(cfg) !== null;
	}
};
