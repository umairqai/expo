import { AuthorizationError, AuthorizationRequest, AuthorizationRequestHandler, AuthorizationResponse, BasicQueryStringUtils, log, AppAuthError, } from '@openid/appauth';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { URL } from './URL';
import { ExpoCrypto } from './ExpoCrypto';
import { ExpoStorageBackend } from './ExpoStorage';
/**
 * key for authorization request.
 */
const authorizationRequestKey = (handle) => {
    return `${handle}_expo_appauth_authorization_request`;
};
/**
 * key for authorization service configuration
 */
const authorizationServiceConfigurationKey = (handle) => {
    return `${handle}_expo_appauth_authorization_service_configuration`;
};
/**
 * key in local storage which represents the current authorization request.
 */
const AUTHORIZATION_REQUEST_HANDLE_KEY = 'expo_appauth_current_authorization_request';
const utils = new BasicQueryStringUtils();
class LocationLikeURL extends URL {
    assign(url) {
        // noop
    }
}
export class ExpoRequestHandler extends AuthorizationRequestHandler {
    constructor(locationLike = window.location, storageBackend = new ExpoStorageBackend(), utils = new BasicQueryStringUtils(), 
    // @ts-ignore
    crypto = new ExpoCrypto()) {
        super(utils, crypto);
        this.locationLike = locationLike;
        this.storageBackend = storageBackend;
        this.request = null;
    }
    performAuthorizationRequest(configuration, request) {
        this.request = request;
        this.authPromise = (async () => {
            // Calling toJson() adds in the code & challenge when possible
            const requestJson = await request.toJson();
            if (this.request) {
                this.request.state = requestJson.state;
            }
            const handle = await this.crypto.generateRandom(10);
            // before you make request, persist all request related data in local storage.
            await Promise.all([
                this.storageBackend.setItem(AUTHORIZATION_REQUEST_HANDLE_KEY, handle),
                this.storageBackend.setItem(authorizationRequestKey(handle), JSON.stringify(requestJson)),
                this.storageBackend.setItem(authorizationServiceConfigurationKey(handle), JSON.stringify(configuration.toJson())),
            ]);
            const url = this.buildRequestUrl(configuration, request);
            log('Making an auth request to ', url);
            if (Platform.OS === 'web') {
                // TODO(Bacon): Use WebBrowser
                this.locationLike.assign(url);
                return;
            }
            const payload = await WebBrowser.openAuthSessionAsync(url, request.redirectUri);
            if (payload.type === 'success') {
                this.locationLike = new LocationLikeURL(payload.url);
                return;
            }
            // There is no standard in the AppAuth-JS library for cancelling an auth flow
            // This is an attempt to emulate the native error.
            throw new AppAuthError(`User cancelled the authorization flow.`, {
                // -3 is the iOS code for user dismissed.
                code: -3,
                // @ts-ignore: message is not on the type
                message: payload.message,
                type: payload.type,
            });
        })();
    }
    getQueryParams() {
        return this.utils.parse(this.locationLike, false /* don't use hash */);
    }
    async getOrRehydrateRequestAsync() {
        if (this.request)
            return this.request;
        const handle = await this.storageBackend.getItem(AUTHORIZATION_REQUEST_HANDLE_KEY);
        if (!handle)
            return null;
        // we have a pending request.
        // fetch authorization request, and check state
        const request = await this.storageBackend
            .getItem(authorizationRequestKey(handle))
            // requires a corresponding instance of result
            .then(result => JSON.parse(result))
            .then(json => new AuthorizationRequest(json));
        this.request = request;
        return request;
    }
    /**
     * Attempts to introspect the contents of storage backend and completes the
     * request.
     */
    async completeAuthorizationRequest() {
        if (this.authPromise)
            await this.authPromise;
        const handle = await this.storageBackend.getItem(AUTHORIZATION_REQUEST_HANDLE_KEY);
        // we have a pending request.
        // fetch authorization request, and check state
        const request = await this.getOrRehydrateRequestAsync();
        if (!handle || !request)
            return null;
        const queryParams = this.getQueryParams();
        const state = queryParams['state'];
        const code = queryParams['code'];
        const error = queryParams['error'];
        // let error: string | undefined = queryParams['error'] ?? queryParams['errorCode'];
        log('Potential authorization request ', queryParams, state, code, error);
        const shouldNotify = state === request.state;
        let authorizationResponse = null;
        let authorizationError = null;
        if (!shouldNotify) {
            log('Mismatched request (state and request_uri) dont match.');
            return null;
        }
        if (error) {
            // get additional optional info.
            const errorUri = queryParams['error_uri'];
            const errorDescription = queryParams['error_description'];
            authorizationError = new AuthorizationError({
                error,
                error_description: errorDescription,
                error_uri: errorUri,
                state,
            });
        }
        else {
            authorizationResponse = new AuthorizationResponse({ code, state });
        }
        // cleanup state
        await Promise.all([
            this.storageBackend.removeItem(AUTHORIZATION_REQUEST_HANDLE_KEY),
            this.storageBackend.removeItem(authorizationRequestKey(handle)),
            this.storageBackend.removeItem(authorizationServiceConfigurationKey(handle)),
        ]);
        log('Delivering authorization response');
        return {
            request,
            response: authorizationResponse,
            error: authorizationError,
        };
    }
}
ExpoRequestHandler.createLocationLike = (url) => {
    return new LocationLikeURL(url);
};
ExpoRequestHandler.getQueryParams = (url) => {
    return utils.parseQueryString(new URL(url).search);
};
//# sourceMappingURL=ExpoRequestHandler.js.map