import assert = require('assert');
import urlLib = require('url');

import auth = require('./auth');
import testLib = require('../lib/test');

const AUTH_SERVER_URL = 'http://acmecloud.com/oauth2/authorize';

// fake implementation of the subset of the Window
// interface used by OAuthFlow to open the cloud storage
// provider's authentication page
class FakeAuthWindowOpener implements auth.AuthWindowOpener {
	expectedRedirectURI: string;

	private accessToken: string;
	private storage: Map<string, string>;

	localStorage: {
		getItem(key: string): string;
		removeItem(key: string): void;
	};

	constructor(expectedRedirectURI: string, accessToken: string) {
		this.expectedRedirectURI = expectedRedirectURI;
		this.storage = new Map<string, string>();
		this.accessToken = accessToken;

		let opener = this;

		this.localStorage = {
			getItem(key: string) {
				return opener.storage.get(key) || '';
			},

			removeItem(key: string) {
				opener.storage.delete(key);
			}
		};
	}

	open(url: string, target: string, options: string) {
		let parsedURL = urlLib.parse(url);
		parsedURL.search = '';
		assert.equal(urlLib.format(parsedURL), AUTH_SERVER_URL);

		let params = urlLib.parse(url, true /* parse query */);
		let redirectUri = params.query['redirect_uri'];
		let state = params.query['state'];

		assert.equal(redirectUri, this.expectedRedirectURI);

		setTimeout(() => {
			this.storage.set('PASSCARDS_OAUTH_TOKEN', JSON.stringify({
				accessToken: this.accessToken,
				state
			}));
		}, 10);

		return {
			closed: false,
			close() {
				this.closed = true;
			}
		};
	}
}

testLib.addAsyncTest('OAuth login', assert => {
	let authRedirectURL = 'http://clientapp/receive-auth-token';
	let authOpts = {
		authServerURL: AUTH_SERVER_URL,
		authRedirectURL
	};

	let accessToken = 'dummytoken';
	let authWindowOpener = new FakeAuthWindowOpener(authRedirectURL, accessToken);
	let authHandler = new auth.OAuthFlow(authOpts);
	return authHandler.authenticate(authWindowOpener).then(credentials => {
		assert.equal(credentials.accessToken, accessToken);
	});
});

// test for the redirect page which receives the OAuth access token
// from the cloud storage provider
testLib.addTest('auth receiver script', assert => {
	// stub out the parts of Window and Document used by the auth
	// receiver script
	let {window, document } = global;
	let storage = new Map<string, string>();
	let windowDidClose = false;

	global.document = {
		location: {
			// note use of URL-encoded chars in 'state' parameter,
			// which should be URI-decoded before being saved
			hash: '#access_token=dummytoken&state=abc%3D%3D'
		}
	};
	global.window = {
		localStorage: {
			setItem(key: string, value: string) {
				storage.set(key, value);
			}
		},

		// add chrome.extension to the Window API so
		// that auth_receiver detects the environment as
		// a Chrome extension
		chrome: {
			extension: {}
		},

		close() {
			windowDidClose = true;
		}
	};

	// load the auth receiver script.
	// This should extract the parameters from the location hash
	// and write them to local storage
	require('./auth_receiver');

	assert.deepEqual(storage.get('PASSCARDS_OAUTH_TOKEN'), JSON.stringify({
		accessToken: 'dummytoken',
		state: 'abc=='
	}));

	// test that the auth window attempts to close itself
	assert.equal(windowDidClose, true);

	global.window = window;
	global.document = document;
});