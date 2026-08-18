import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ProviderRequestAuth } from '#/kosong/contract/provider';

import type { OAuthRef } from '../provider/provider';

export interface IModelOAuthTokens {
  readonly _serviceBrand: undefined;

  hasCachedAccessToken(provider: string, oauthRef: OAuthRef): Promise<boolean>;
  getAccessToken(
    provider: string,
    oauthRef: OAuthRef,
    options?: { readonly force?: boolean },
  ): Promise<string>;
  getRequestAuth(
    provider: string,
    oauthRef: OAuthRef,
    options?: { readonly force?: boolean },
  ): Promise<ProviderRequestAuth>;
}

export const IModelOAuthTokens: ServiceIdentifier<IModelOAuthTokens> =
  createDecorator<IModelOAuthTokens>('modelOAuthTokens');
