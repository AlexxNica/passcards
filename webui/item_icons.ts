/// <reference path="../typings/DefinitelyTyped/q/Q.d.ts" />
/// <reference path="../typings/DefinitelyTyped/underscore/underscore.d.ts" />
/// <reference path="../typings/react-0.12.d.ts" />
/// <reference path="../typings/URIjs.d.ts" />
/// <reference path="../typings/dom.d.ts" />

import Q = require('q');
import react = require('react');
import stringutil = require('../lib/base/stringutil');
import typed_react = require('typed-react');
import underscore = require('underscore');
import urijs = require('URIjs');

import collectionutil = require('../lib/base/collectionutil');
import err_util = require('../lib/base/err_util');
import event_stream = require('../lib/base/event_stream');
import key_value_store = require('../lib/base/key_value_store');
import reactutil = require('./reactutil');
import site_info = require('../lib/siteinfo/site_info');
import style = require('./base/style');
import theme = require('./theme');
import url_util = require('../lib/base/url_util');

/** Fetch state for an icon returned by ItemIconProvider query.
  */
export enum IconFetchState {
	Fetching, ///< Icons associated with the URL are currently being fetched
	NoIcon, ///< The fetch completed but no matching icon was found
	Found ///< The fetch completed and found an icon
}

export interface Icon {
	iconUrl: string;
	state: IconFetchState;
}

/** Provides icon URLs for items.
  *
  * Call query(url) to lookup the icon associated with a given URL.
  * If a cached icon is available, it will be returned, otherwise a lookup
  * will be triggered.
  *
  * When the icon associated with a previously looked up URL changes,
  * the updated event stream will emit the normalized URL.
  */
export class ItemIconProvider {
	private tempCache: Map<string,Icon>;
	private diskCache : Cache;
	private provider: site_info.SiteInfoProvider;
	private iconSize: number;

	private static LOADING_ICON = 'icons/loading.png';
	private static DEFAULT_ICON = 'icons/default.png';

	/** Stream of icon update events.
	  * Emits the normalized URL (using url_util.normalize) of the location
	  * when the icon for that location is updated.
	  */
	updated: event_stream.EventStream<string>;
	
	/** Create an icon provider which uses @p provider to fetch
	  * icon data. @p iconSize specifies the size of icon to make from
	  * the available icons for a given URL.
	  *
	  * @param cacheStore A key/value store to use for persisting fetched icons
	  * @param provider A provider to query for icons for a given domain
	  * @param iconSize The preferred size for icons generated by the provider.
	  *                 Depending on the images that can be retrieved for a URL,
	  *                 the actual icon image may be larger or smaller than the preferred
	  *                 size.
	  */
	constructor(cacheStore: key_value_store.ObjectStore, provider: site_info.SiteInfoProvider, iconSize: number) {
		this.tempCache = new collectionutil.PMap<string,Icon>();
		this.diskCache = new Cache(cacheStore);
		this.provider = provider;
		this.iconSize = iconSize;
		this.updated = new event_stream.EventStream<string>();

		// increase the number of max listeners since we will have
		// one listener for each visible icon
		this.updated.maxListeners = 100;

		this.provider.updated.listen((url) => {
			var entry = this.provider.status(url);

			if (entry.state == site_info.QueryState.Ready) {
				this.updateCacheEntry(url, entry.info.icons);

				if (entry.info.icons.length > 0) {
					// cache icons for future use
					this.diskCache.insert(url, {
						icons: entry.info.icons
					}).catch((err) => {
						console.log('Caching icons for URL', url, 'failed', err.message);
					});
				}

				// free icon data
				this.provider.forget(url);
			}
		});
	}

	/** Returns true if a given @p updateUrl from ItemIconProvider.updated
	  * matches an item with location @p location.
	  *
	  * The update URL may not match the original item location due to
	  * normalization or if a fallback URL has been used to find
	  * an icon for the item.
	  */
	updateMatches(updateUrl: string, itemUrl: string) {
		itemUrl = url_util.normalize(itemUrl);
		return updateUrl == itemUrl ||
		       updateUrl == this.fallbackUrlForIcon(itemUrl);
	}

	/** Fetch the icon for a given URL. */
	query(url: string) : Icon {
		url = url_util.normalize(url);

		if (url.length == 0) {
			return {
				iconUrl: ItemIconProvider.DEFAULT_ICON,
				state: IconFetchState.NoIcon
			}
		}

		if (this.tempCache.get(url)) {
			var cachedIcon = this.tempCache.get(url);
			if (cachedIcon.state == IconFetchState.NoIcon) {
				var fallbackUrl = this.fallbackUrlForIcon(url);
				if (this.tempCache.get(fallbackUrl)) {
					return this.tempCache.get(fallbackUrl);
				}
			}
			return cachedIcon;
		} else {
			var icon : Icon = {
				iconUrl: ItemIconProvider.LOADING_ICON,
				state: IconFetchState.Fetching
			};
			this.tempCache.set(url, icon);
			
			this.diskCache.query(url).then((entry) => {
				if (entry) {
					this.updateCacheEntry(url, entry.icons);
				} else {
					this.provider.lookup(url);
				}
			}).catch((err) => {
				console.log('Disk cache lookup for', url, 'failed:', err, err.message, err.fileName, err.lineNumber);
				this.provider.lookup(url);
			});

			return icon;
		}
	}

	private updateCacheEntry(url: string, icons: site_info.Icon[]) {
		var icon = this.tempCache.get(url);
		icon.iconUrl = this.makeIconUrl(icons, this.iconSize);
		if (icon.iconUrl != '') {
			icon.state = IconFetchState.Found;
		} else {
			icon.state = IconFetchState.NoIcon;
			icon.iconUrl = ItemIconProvider.DEFAULT_ICON;
		}
		this.updated.publish(url);

		if (icons.length == 0) {
			// if a query against the actual location returns no suitable icons,
			// try a query against the main domain
			var fallbackUrl = this.fallbackUrlForIcon(url);
			if (fallbackUrl && fallbackUrl != url) {
				this.query(this.fallbackUrlForIcon(url));
			}
		}
	}

	// Take a set of icons for a site, pick the best one for a given target
	// image width of @p minSize and return a blob URL for the image
	// data
	private makeIconUrl(icons: site_info.Icon[], minSize: number) {
		if (icons.length == 0) {
			return '';
		}

		var iconsBySize = underscore.sortBy(icons, (icon) => {
			return icon.width;
		});

		// try to find a square icon of the required-size
		var squareIcon: site_info.Icon;
		var nonSquareIcon: site_info.Icon;

		for (var i=0; i < iconsBySize.length; i++) {
			var candidate = iconsBySize[i];
			if (candidate.width >= minSize) {
				if (candidate.width == candidate.height) {
					squareIcon = squareIcon || candidate;
				} else {
					nonSquareIcon = nonSquareIcon || candidate;
				}
			}
		}

		var icon = squareIcon || nonSquareIcon;
		if (!icon) {
			icon = iconsBySize[iconsBySize.length-1];
		}
		
		// FIXME [TS/1.1] - Blob ctor is missing arguments
		var _blob = <any>Blob;
		var iconBlob = new _blob([icon.data]);
		var blobUrl = URL.createObjectURL(iconBlob);

		return blobUrl;
	}

	// Returns a fallback URL to try if querying an item's URL does
	// not return an icon.
	//
	// (eg. 'https://sub.domain.com/foo/bar' => 'https://www.domain.com')
	//
	// We use HTTPS here although there are many sites which do have secure
	// login pages but whoose main site is not reachable over HTTPS
	// due to an invalid certificate or simply lack of SSL support.
	//
	// We could try an HTTP-only variant of the lookup but this is open
	// to MITM spoofing if run from the user's system.
	//
	private fallbackUrlForIcon(url: string) {
		url = url_util.normalize(url);
		var parsedUrl = urijs(url);
		return 'https://www.' + parsedUrl.domain();
	}
}

interface CacheEntry {
	icons: site_info.Icon[];
}

class Cache {
	constructor(private store: key_value_store.ObjectStore) {
	}

	/** Look up the icons for @p url in the cache.
	  * Resolves with the cache entry if found or undefined
	  * if no such entry exists.
	  */
	query(url: string) : Q.Promise<CacheEntry> {
		return this.withKey(url, (key) => {
			return this.store.get<CacheEntry>(key);
		});
	}

	insert(url: string, icons: CacheEntry) : Q.Promise<void> {
		return this.withKey(url, (key) => {
			return this.store.set(key, icons);
		});
	}

	clear(url: string) : Q.Promise<void> {
		return this.withKey(url, (key) => {
			return this.store.remove(key);
		});
	}

	private withKey<T>(url: string, f: (key: string) => Q.Promise<T>) : Q.Promise<T> {
		var key = urijs(url_util.normalize(url)).hostname();
		if (!key) {
			return Q.reject<T>(new err_util.BaseError('Invalid URL'));
		}
		return f(key);
	}
}

export class IconControlProps {
	location: string;
	iconProvider: ItemIconProvider;
	isFocused: boolean;
}

export class IconControl extends typed_react.Component<IconControlProps, {}> {
	private iconUpdateListener: (url: string) => void;

	private setupIconUpdateListener(iconProvider: ItemIconProvider) {
		if (!this.iconUpdateListener) {
			this.iconUpdateListener = (url) => {
				if (this.props.location &&
				    this.props.iconProvider.updateMatches(url, this.props.location) &&
				    this.isMounted()) {
					this.forceUpdate();
				}
			};
		}
		if (this.props.iconProvider) {
			this.props.iconProvider.updated.ignore(this.iconUpdateListener);
		}
		iconProvider.updated.listen(this.iconUpdateListener);
	}

	componentDidMount() {
		if (!this.iconUpdateListener) {
			this.setupIconUpdateListener(this.props.iconProvider);
		}
	}

	componentWillUnmount() {
		if (this.iconUpdateListener && this.props.iconProvider) {
			this.props.iconProvider.updated.ignore(this.iconUpdateListener);
		}
	}

	componentWillReceiveProps(nextProps: IconControlProps) {
		this.setupIconUpdateListener(nextProps.iconProvider);
	}

	render() {
		var iconUrl = this.props.iconProvider.query(this.props.location).iconUrl;

		return react.DOM.div({className: style.classes(theme.itemIcon.container,
			  this.props.isFocused ? theme.itemIcon.container.focused : null)},
			react.DOM.img({className: style.classes(theme.itemIcon.icon), src: iconUrl})
		);
	}
}

export var IconControlF = reactutil.createFactory(IconControl);

