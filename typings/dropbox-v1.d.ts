// see http://coffeedoc.info/github/dropbox/dropbox-js/master/class_index.html
declare module "dropbox-v1" {
	export interface ApiKeys {
		key: string
		secret?: string
	}

	export var Client: {
		new (keys: ApiKeys): Client;
	};

	export interface ApiError {
		status: number;
		method: string;
		url: string;
		responseText: string;
		response: any;
	}

	export interface EventSource<T> {
		addListener(fn: (data: T) => void): EventSource<T>;
		removeListener(fn: (data: T) => void): EventSource<T>;
	}

	export interface ReadFileOptions {
		// TODO
	}

	export interface WriteFileOptions {
		parentRev?: string;
		lastVersionTag?: string;
	}

	export interface ReadDirOptions {
		// TODO
	}

	export interface SearchOptions {
		// TODO
	}

	export interface StatOptions {
		// TODO
	}

	export module AuthDriver {
		export var BrowserBase: {
			cleanupLocation(): void;
		}

		interface RedirectDriverOpts {
			redirectUrl?: string;
			redirectFile?: string;
			scope?: string;
			rememberUser?: boolean;
		}

		interface PopupDriverOpts {
			receiverUrl?: string;
			receiverFile?: string;
			scope?: string;
			rememberUser?: boolean;
		}

		export var NodeServer: {
			new (port: number): AuthDriver;
		}

		export var Redirect: {
			new (options: RedirectDriverOpts): AuthDriver;
		}

		export var Popup: {
			new (options: PopupDriverOpts): AuthDriver;
		}

		interface ChromeDriverOpts {
			receiverPath: string;
		}

		export var ChromeExtension: {
			new (options: ChromeDriverOpts): AuthDriver;
		}
	}

	export module File {
		export interface Stat {
			name: string;
			path: string;
			inAppFolder: boolean;
			isFolder: boolean;
			isFile: boolean;
			isRemoved: boolean;
			typeIcon: string;
			versionTag: string;
			contentHash: string;
			mimeType: string;
			size: number;
			humanSize: string;
			hasThumbnail: boolean;
			modifiedAt: Date;
			clientModifiedAt: Date;
		}
	}

	export interface AccountInfo {
		name?: string;
		email?: string;
		countryCode?: string;
		uid: string;
		referralUrl: string;
		publicAppUrl: string;
		quota: number;
		usedQuota: number;
		privateBytes: number;
		sharedBytes: number;
	}

	export interface AccountInfoOptions {
		httpCache?: boolean;
	}

	export interface AuthDriver {
		// TODO
	}

	export interface Client {
		authDriver(driver: AuthDriver): Client;

		authenticate(callback: (error: ApiError) => any): Client;
		signOut(callback: (error: ApiError) => void): XMLHttpRequest;

		credentials(): Object;
		isAuthenticated(): boolean;
		getAccountInfo(options: AccountInfoOptions, callback: (error: ApiError, info: AccountInfo) => void): XMLHttpRequest;
		mkdir(path: string, callback: (error: ApiError, folder: File.Stat) => void): XMLHttpRequest;
		readFile(path: string, options: ReadFileOptions, callback: (error: ApiError, content: string) => void): XMLHttpRequest;
		readdir(path: string, options: ReadDirOptions, callback: (error: any, names: string[], folderInfo: File.Stat, files: File.Stat[]) => void): XMLHttpRequest;
		remove(path: string, callback: (error: ApiError) => void): XMLHttpRequest;
		search(path: string, namePattern: string, options: SearchOptions, callback: (error: ApiError, matches: File.Stat[]) => void): XMLHttpRequest;
		setCredentials(credentials: Object): Client;
		stat(path: string, options: StatOptions, callback: (error: ApiError, file: File.Stat) => void): XMLHttpRequest;
		writeFile(path: string, content: string, options: WriteFileOptions,
		          callback: (error: ApiError, stat: File.Stat) => void): XMLHttpRequest;

		onError: EventSource<ApiError>;
	}
}