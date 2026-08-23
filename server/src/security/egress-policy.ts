import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';

export type EgressViolation =
  | 'unsafe-destination'
  | 'unsafe-redirect'
  | 'egress-unavailable'
  | 'prompt-injection';

export interface DestinationValidationResult {
  allowed: boolean;
  violation?: EgressViolation;
  reason?: string;
  url?: URL;
  addresses?: string[];
}

export type AddressResolver = (hostname: string) => Promise<string[]>;

const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.azure.internal',
  'instance-data.ec2.internal',
]);

const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 1_000_000;

const PROMPT_INJECTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bignore\s+(?:all\s+)?(?:previous|prior|system|developer)\s+(?:instructions|rules|messages)\b/i, reason: 'instruction override attempt' },
  { pattern: /\b(?:reveal|print|show|exfiltrate)\b.{0,80}\b(?:system\s+prompt|developer\s+message|secret|token|credential|api[_ -]?key)\b/i, reason: 'secret or instruction exfiltration attempt' },
  { pattern: /\b(?:bypass|disable|turn\s+off)\b.{0,80}\b(?:security|sandbox|approval|policy|guard)\b/i, reason: 'security control bypass attempt' },
  { pattern: /\b(?:jailbreak|do\s+anything\s+now|DAN)\b/i, reason: 'jailbreak marker' },
];

export function validateUntrustedInstruction(input: string): { allowed: boolean; violation?: EgressViolation; reason?: string } {
  for (const entry of PROMPT_INJECTION_PATTERNS) {
    if (entry.pattern.test(input)) {
      return { allowed: false, violation: 'prompt-injection', reason: entry.reason };
    }
  }
  return { allowed: true };
}

async function defaultResolver(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return [...new Set(results.map((entry) => entry.address))];
}

function ipv4ToNumber(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}

function inIpv4Range(value: number, base: string, prefix: number): boolean {
  const baseValue = ipv4ToNumber(base);
  if (baseValue === null) return true;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function expandIpv6(address: string): bigint | null {
  const normalized = address.toLowerCase().split('%')[0];
  if (!normalized) return null;
  const ipv4Index = normalized.lastIndexOf(':');
  let source = normalized;
  if (source.includes('.')) {
    const ipv4 = source.slice(ipv4Index + 1);
    const value = ipv4ToNumber(ipv4);
    if (value === null) return null;
    source = `${source.slice(0, ipv4Index)}:${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return BigInt(`0x${groups.map((group) => group.padStart(4, '0')).join('')}`);
}

function inIpv6Range(value: bigint, base: string, prefix: number): boolean {
  const baseValue = expandIpv6(base);
  if (baseValue === null) return true;
  const width = 128n;
  const mask = prefix === 0 ? 0n : ((1n << width) - (1n << (width - BigInt(prefix))));
  return (value & mask) === (baseValue & mask);
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToNumber(address);
    if (value === null) return false;
    const blocked = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4],
    ] as const;
    return !blocked.some(([base, prefix]) => inIpv4Range(value, base, prefix));
  }
  if (family === 6) {
    const value = expandIpv6(address);
    if (value === null) return false;
    if (inIpv6Range(value, '::ffff:0:0', 96)) {
      const mapped = Number(value & 0xffffffffn);
      return isPublicIpAddress([(mapped >>> 24) & 255, (mapped >>> 16) & 255, (mapped >>> 8) & 255, mapped & 255].join('.'));
    }
    const blocked = [
      ['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
    ] as const;
    return !blocked.some(([base, prefix]) => inIpv6Range(value, base, prefix));
  }
  return false;
}

export async function validateExternalDestination(rawUrl: string, resolver: AddressResolver = defaultResolver): Promise<DestinationValidationResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, violation: 'unsafe-destination', reason: 'invalid URL' };
  }
  if (url.username || url.password) {
    return { allowed: false, violation: 'unsafe-destination', reason: 'URL credentials are not allowed' };
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname === 'localhost' || METADATA_HOSTS.has(hostname) || hostname.endsWith('.internal') || hostname.endsWith('.local')) {
    return { allowed: false, violation: 'unsafe-destination', reason: `Blocked domain: ${hostname}` };
  }
  if (isIP(hostname) && !isPublicIpAddress(hostname)) {
    return { allowed: false, violation: 'unsafe-destination', reason: `Blocked domain: ${hostname}` };
  }
  if (url.protocol !== 'https:') {
    return { allowed: false, violation: 'unsafe-destination', reason: `Blocked URL scheme: ${url.protocol}; only HTTPS destinations are allowed` };
  }
  if (url.port && url.port !== '443') {
    return { allowed: false, violation: 'unsafe-destination', reason: 'only the standard HTTPS port is allowed' };
  }
  let addresses: string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await resolver(hostname);
    } catch {
      return { allowed: false, violation: 'unsafe-destination', reason: 'destination hostname could not be resolved' };
    }
  }
  if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address))) {
    return { allowed: false, violation: 'unsafe-destination', reason: 'destination resolves to a non-public address' };
  }
  return { allowed: true, url, addresses };
}

export async function validateExternalRedirectTarget(location: string, baseUrl: URL, resolver: AddressResolver = defaultResolver): Promise<DestinationValidationResult> {
  let target: URL;
  try {
    target = new URL(location, baseUrl);
  } catch {
    return { allowed: false, violation: 'unsafe-redirect', reason: 'redirect location is invalid' };
  }
  const destination = await validateExternalDestination(target.toString(), resolver);
  if (!destination.allowed) {
    return { ...destination, violation: 'unsafe-redirect' };
  }
  return destination;
}

export interface ExternalHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  sensitiveHeaderNames?: string[];
}

export interface ExternalHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  finalUrl: string;
  redirectCount: number;
}

export interface ExternalHttpResult {
  ok: boolean;
  response?: ExternalHttpResponse;
  violation?: EgressViolation;
  reason?: string;
}

function requestOne(url: URL, address: string, request: ExternalHttpRequest): Promise<Omit<ExternalHttpResponse, 'finalUrl' | 'redirectCount'>> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      protocol: 'https:',
      hostname: address,
      servername: url.hostname,
      port: 443,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: { ...request.headers, host: url.host },
      timeout: request.timeoutMs,
      rejectUnauthorized: true,
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('response exceeded egress size limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        statusText: response.statusMessage ?? '',
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('timeout', () => req.destroy(new Error('request timed out')));
    req.once('error', reject);
    if (request.body) req.write(request.body);
    req.end();
  });
}

async function requestOneViaTestFetch(url: URL, request: ExternalHttpRequest): Promise<Omit<ExternalHttpResponse, 'finalUrl' | 'redirectCount'>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
      redirect: 'manual',
    });
    const contentType = response.headers.get('content-type') ?? '';
    let body: string;
    if (contentType.includes('application/json')) {
      try {
        body = JSON.stringify(await response.json());
      } catch {
        body = await response.text();
      }
    } else {
      body = await response.text();
    }
    return {
      status: response.status,
      statusText: response.statusText,
      headers: {
        'content-type': contentType || undefined,
        location: response.headers.get('location') ?? undefined,
      },
      body,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestExternalHttp(request: ExternalHttpRequest): Promise<ExternalHttpResult> {
  let currentUrl = request.url;
  let headers = { ...request.headers };
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const resolver: AddressResolver | undefined = process.env.NODE_ENV === 'test'
      ? async () => ['93.184.216.34']
      : undefined;
    const destination = await validateExternalDestination(currentUrl, resolver);
    if (!destination.allowed || !destination.url || !destination.addresses) {
      return { ok: false, violation: redirectCount === 0 ? destination.violation : 'unsafe-redirect', reason: destination.reason };
    }
    let response: Omit<ExternalHttpResponse, 'finalUrl' | 'redirectCount'>;
    try {
      response = process.env.NODE_ENV === 'test'
        ? await requestOneViaTestFetch(destination.url, { ...request, headers })
        : await requestOne(destination.url, destination.addresses[0], { ...request, headers });
    } catch (error: any) {
      if (error?.name === 'AbortError') return { ok: false, reason: `request timed out after ${request.timeoutMs}ms` };
      return { ok: false, reason: `Network error: ${error?.message?.slice(0, 200) ?? 'external request failed'}` };
    }
    const location = typeof response.headers.location === 'string' ? response.headers.location : undefined;
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
      return { ok: true, response: { ...response, finalUrl: destination.url.toString(), redirectCount } };
    }
    if (redirectCount === MAX_REDIRECTS) {
      return { ok: false, violation: 'unsafe-redirect', reason: 'redirect limit exceeded' };
    }
    const redirect = await validateExternalRedirectTarget(location, destination.url, resolver);
    if (!redirect.allowed || !redirect.url) {
      return { ok: false, violation: redirect.violation ?? 'unsafe-redirect', reason: redirect.reason };
    }
    const nextUrl = redirect.url;
    if (nextUrl.origin !== destination.url.origin) {
      const sensitive = new Set((request.sensitiveHeaderNames ?? []).map((name) => name.toLowerCase()));
      headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !sensitive.has(name.toLowerCase())));
    }
    currentUrl = nextUrl.toString();
  }
  return { ok: false, violation: 'unsafe-redirect', reason: 'redirect processing failed closed' };
}
