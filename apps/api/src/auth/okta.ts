import * as oidc from 'openid-client';

export interface AuthorizationParams {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OktaClaims {
  sub: string;
  email: string;
  name: string;
}

export interface OktaAdapter {
  /** Returns the authorization URL the user should be redirected to, plus the state/nonce/codeVerifier to persist. */
  buildAuthorizationUrl(): Promise<AuthorizationParams>;
  /** Validates the callback and returns the verified ID token claims. */
  exchangeCode(input: {
    code: string;
    state: string;
    nonce: string;
    codeVerifier: string;
    receivedState: string;
  }): Promise<OktaClaims>;
}

export interface OktaConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
}

/**
 * Real adapter. Uses openid-client v6's functional API.
 * Discovery happens lazily on first use, then is cached.
 */
export class OpenIdClientAdapter implements OktaAdapter {
  private configPromise: Promise<oidc.Configuration> | null = null;

  constructor(private readonly cfg: OktaConfig) {}

  private async config(): Promise<oidc.Configuration> {
    if (!this.configPromise) {
      this.configPromise = oidc.discovery(
        new URL(this.cfg.issuer),
        this.cfg.clientId,
        this.cfg.clientSecret
      );
    }
    return this.configPromise;
  }

  async buildAuthorizationUrl(): Promise<AuthorizationParams> {
    const config = await this.config();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();

    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.cfg.redirectUri,
      scope: this.cfg.scope,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });

    return { url: url.toString(), state, nonce, codeVerifier };
  }

  async exchangeCode(input: {
    code: string;
    state: string;
    nonce: string;
    codeVerifier: string;
    receivedState: string;
  }): Promise<OktaClaims> {
    if (input.state !== input.receivedState) {
      throw new Error('state mismatch');
    }
    const config = await this.config();
    const callbackUrl = new URL(this.cfg.redirectUri);
    callbackUrl.searchParams.set('code', input.code);
    callbackUrl.searchParams.set('state', input.receivedState);

    const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: input.codeVerifier,
      expectedState: input.state,
      expectedNonce: input.nonce,
      idTokenExpected: true,
    });

    const claims = tokens.claims();
    if (!claims) throw new Error('no id token claims');
    const sub = String(claims.sub ?? '');
    const email = String((claims as Record<string, unknown>).email ?? '');
    const name = String((claims as Record<string, unknown>).name ?? '');
    if (!sub || !email || !name) {
      throw new Error('missing required claims (sub/email/name)');
    }
    return { sub, email, name };
  }
}

/**
 * Test adapter — deterministic, no network. Tests inject this directly into AppDeps.oktaAdapter.
 */
export interface MockOktaAdapterOptions {
  /** Override the canned claims that `exchangeCode` will return. */
  claims?: OktaClaims;
  /** Force `exchangeCode` to reject (e.g. to test the callback's error path). */
  shouldFail?: 'state' | 'token' | null;
}

export function makeMockOktaAdapter(opts: MockOktaAdapterOptions = {}): OktaAdapter {
  return {
    async buildAuthorizationUrl() {
      return {
        url: 'https://mock-okta.test/authorize?fake=1',
        state: 'mock-state',
        nonce: 'mock-nonce',
        codeVerifier: 'mock-code-verifier',
      };
    },
    async exchangeCode(input) {
      if (opts.shouldFail === 'state' || input.state !== input.receivedState) {
        throw new Error('state mismatch');
      }
      if (opts.shouldFail === 'token') {
        throw new Error('token exchange failed');
      }
      return (
        opts.claims ?? {
          sub: 'okta-sub-123',
          email: 'alice@polygon.technology',
          name: 'Alice Tester',
        }
      );
    },
  };
}

/**
 * An adapter that throws on use. Wired in when AUTH_MODE=mock so the OIDC routes
 * stay registered but produce a clear 503 if a stray hit lands on them.
 */
export function makeDisabledOktaAdapter(): OktaAdapter {
  return {
    async buildAuthorizationUrl() {
      throw new Error('OIDC disabled (AUTH_MODE=mock)');
    },
    async exchangeCode() {
      throw new Error('OIDC disabled (AUTH_MODE=mock)');
    },
  };
}
