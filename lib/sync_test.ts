/// <reference path="../typings/DefinitelyTyped/clone/clone.d.ts" />
/// <reference path="../typings/DefinitelyTyped/q/Q.d.ts" />
/// <reference path="../typings/DefinitelyTyped/underscore/underscore.d.ts" />

import clone = require('clone');
import Q = require('q');

import agile_keychain_crypto = require('./agile_keychain_crypto');
import asyncutil = require('./base/asyncutil');
import item_builder = require('./item_builder');
import item_store = require('./item_store');
import key_agent = require('./key_agent');
import agile_keychain = require('./agile_keychain');
import sync = require('./sync');
import temp_store = require('./temp_store');
import testLib = require('./test');

interface Env {
	localStore: temp_store.Store;
	syncer: sync.Syncer;
	cloudStore: temp_store.Store;
	keyAgent: key_agent.KeyAgent;
}

function setup(): Q.Promise<Env> {
	const VAULT_PASS = 'testpass';
	const VAULT_PASS_ITERATIONS = 100;
	const VAULT_PASS_HINT = 'testhint';

	let keyAgent = new key_agent.SimpleKeyAgent();
	let cloudStoreKeyAgent = new key_agent.SimpleKeyAgent();
	let cloudStore = new temp_store.Store(cloudStoreKeyAgent, 'Cloud Store');
	let localStore = new temp_store.Store(keyAgent, 'Local Store')
	let syncer = new sync.CloudStoreSyncer(localStore, cloudStore);

	return agile_keychain_crypto.generateMasterKey(VAULT_PASS,
		VAULT_PASS_ITERATIONS).then(keyList => {
		let keys = agile_keychain.convertKeys(keyList.list);
		return Q.all([localStore.saveKeys(keys, VAULT_PASS_HINT),
			cloudStore.saveKeys(keys, VAULT_PASS_HINT)]);
	}).then(() => {
		return Q.all([localStore.unlock(VAULT_PASS), cloudStore.unlock(VAULT_PASS)]);
	}).then(() => {
		return {
			localStore: localStore,
			syncer: syncer,
			cloudStore: cloudStore,
			keyAgent: keyAgent
		};
	});
}

// create a cloudStore, a local store and a syncer.
// Add a single item to the cloudStore and the cloudStore, local store, syncer and
// a reference to the item in the cloudStore
function setupWithItem(): Q.Promise<{ env: Env; item: item_store.Item }> {
	var env: Env;

	var item = new item_builder.Builder(item_store.ItemTypes.LOGIN)
	.setTitle('sync me')
	.addLogin('jim@acme.org')
	.addUrl('acme.org')
	.item();

	return setup().then(_env => {
		env = _env;
		return item.saveTo(env.cloudStore);
	}).then(() => {
		return {
			env: env,
			item: item
		}
	});
}

testLib.addAsyncTest('sync cloudStore keys and password hint', (assert) => {
	let env: Env;

	return setup().then(_env => {
		env = _env;
		return env.syncer.syncKeys();
	}).then(() => {
		return Q.all([env.localStore.listKeys(), env.localStore.passwordHint()]);
	}).then(keyAndHint => {
		let keys = <key_agent.Key[]>keyAndHint[0];
		let hint = <string>keyAndHint[1];

		assert.equal(keys.length, 1);
		assert.equal(hint, 'testhint');
	});
});

testLib.addAsyncTest('sync keys without hint', assert => {
	let env: Env;
	return setup().then(_env => {
		env = _env;
		
		// verify that syncing keys succeeds if the password
		// hint is not available
		env.cloudStore.passwordHint = () => {
			return Q.reject<string>(new Error('Fail to fetch hint'));
		};
	}).then(() => {
		return env.syncer.syncKeys();
	}).then(() => {
		return Q.all([env.localStore.listKeys(), env.localStore.passwordHint()]);
	}).then((keysAndHint: [key_agent.Key[], string]) => {
		assert.equal(keysAndHint[0].length, 1);
		assert.equal(keysAndHint[1], '');
	});
});

testLib.addAsyncTest('sync cloudStore items to store', (assert) => {
	var env: Env;

	// 1. save a new item to the cloudStore
	var item = new item_builder.Builder(item_store.ItemTypes.LOGIN)
	.setTitle('sync me')
	.addLogin('testuser@gmail.com')
	.addUrl('accounts.google.com')
	.item();

	return setup().then((_env) => {
		env = _env;
		return item.saveTo(env.cloudStore);
	}).then(() => {
		// 2. sync and verify that the updated items were
		//    synced to the local store
		return env.syncer.syncItems();
	}).then((syncStats) => {
		assert.equal(syncStats.updated, 1);
		assert.equal(syncStats.total, 1);
		return env.localStore.listItems();
	}).then((storeItems) => {
		// 3. update the item in the cloudStore, sync again
		//    and verify that the updates are synced
		//    to the local store
		assert.equal(storeItems.length, 1);
		assert.equal(storeItems[0].title, item.title);
		assert.ok(sync.itemUpdateTimesEqual(storeItems[0].createdAt, item.createdAt));
		assert.deepEqual(storeItems[0].locations, item.locations);
		return storeItems[0].getContent();
	}).then((content) => {
		// 3.1. Check that the encrypted content was synced
		//      successfully
		testLib.assertEqual(assert, content.formFields, [{
			id: '',
			name: 'username',
			type: item_store.FormFieldType.Text,
			designation: 'username',
			value: 'testuser@gmail.com'
		}]);

		item.title = 'sync me - updated';
		return item.save();
	}).then(() => {
		return env.syncer.syncItems();
	}).then((syncStats) => {
		assert.equal(syncStats.updated, 1);
		assert.equal(syncStats.total, 1);
		return env.localStore.listItems();
	}).then((storeItems) => {
		assert.equal(storeItems.length, 1);
		assert.equal(storeItems[0].title, item.title);
	});
});

testLib.addAsyncTest('sync store items to cloudStore', (assert) => {
	var env: Env;

	// 1. Save a new item to the store
	var item = new item_builder.Builder(item_store.ItemTypes.LOGIN)
	.setTitle('store item')
	.addLogin('testuser2@gmail.com')
	.addUrl('acme.org')
	.item();

	return setup().then((_env) => {
		env = _env;
		return item.saveTo(env.localStore);
	}).then(() => {
		// 2. Sync and verify that item was added to cloudStore
		return env.syncer.syncItems();
	}).then((syncStats) => {
		assert.equal(syncStats.updated, 1);
		assert.equal(syncStats.total, 1);
		return env.cloudStore.listItems();
	}).then((vaultItems) => {
		assert.equal(vaultItems.length, 1);
		assert.equal(vaultItems[0].title, item.title);
		assert.ok(sync.itemUpdateTimesEqual(vaultItems[0].updatedAt, item.updatedAt));
		assert.deepEqual(vaultItems[0].locations, item.locations);
		return vaultItems[0].getContent();
	}).then((content) => {
		testLib.assertEqual(assert, content.formFields, [{
			id: '',
			name: 'username',
			type: item_store.FormFieldType.Text,
			designation: 'username',
			value: 'testuser2@gmail.com'
		}]);

		// 3. Update item in store, sync and verify that
		// cloudStore item is updated
		item.title = 'store item - updated';
		return item.save();
	}).then(() => {
		return env.syncer.syncItems();
	}).then(() => {
		return env.cloudStore.listItems();
	}).then((vaultItems) => {
		assert.equal(vaultItems.length, 1);
		assert.equal(vaultItems[0].title, item.title);
		assert.ok(sync.itemUpdateTimesEqual(vaultItems[0].updatedAt, item.updatedAt));
	});
});

testLib.addAsyncTest('merge store and cloudStore item updates', (assert) => {
	var env: Env;
	var item = new item_builder.Builder(item_store.ItemTypes.LOGIN)
	.setTitle('acme.org')
	.addLogin('jim@acme.org')
	.addUrl('acme.org')
	.item();

	return setup().then((_env) => {
		env = _env;
		return item.saveTo(env.localStore);
	}).then(() => {
		return env.syncer.syncItems();
	}).then(() => {
		return env.cloudStore.loadItem(item.uuid);
	}).then(vaultItem => {
		assert.equal(vaultItem.item.title, item.title);
		assert.equal(item.trashed, vaultItem.item.trashed);
		assert.ok(sync.itemUpdateTimesEqual(item.updatedAt, vaultItem.item.updatedAt));

		// update item in cloudStore and store and save to both
		vaultItem.item.trashed = true;
		item.title = 'acme.org - client update';
		return Q.all([item.save(), vaultItem.item.save()]);
	}).then(() => {
		return env.syncer.syncItems();
	}).then(() => {
		return Q.all([env.localStore.loadItem(item.uuid), env.cloudStore.loadItem(item.uuid)]);
	}).then((items) => {
		var storeItem = <item_store.Item>items[0].item;
		var vaultItem = <item_store.Item>items[1].item;
		assert.equal(storeItem.title, vaultItem.title);
		assert.equal(storeItem.trashed, vaultItem.trashed);
		assert.ok(sync.itemUpdateTimesEqual(storeItem.updatedAt, vaultItem.updatedAt));
	});
});

testLib.addAsyncTest('sync progress', (assert) => {
	var env: Env;

	var item = new item_builder.Builder(item_store.ItemTypes.LOGIN)
	.setTitle('sync me')
	.addLogin('testuser@gmail.com')
	.addUrl('accounts.google.com')
	.item();

	var progressUpdates: sync.SyncProgress[] = [];

	return setup().then((_env) => {
		env = _env;
		env.syncer.onProgress.listen((progress) => {
			progressUpdates.push(<sync.SyncProgress>clone(progress));
		});
		return item.saveTo(env.cloudStore);
	}).then(() => {
		return env.syncer.syncItems();
	}).then((finalState) => {
		assert.deepEqual(progressUpdates, [{
			state: sync.SyncState.ListingItems,
			updated: 0,
			failed: 0,
			total: 0,
			active: 0
		}, {
				state: sync.SyncState.SyncingItems,
				active: 0,
				updated: 0,
				failed: 0,
				total: 1
			}, {
				state: sync.SyncState.SyncingItems,
				active: 0,
				updated: 1,
				failed: 0,
				total: 1
			}, {
				state: sync.SyncState.Idle,
				active: 0,
				updated: 1,
				failed: 0,
				total: 1
			}], 'check that expected progress updates were received');

		assert.deepEqual(finalState, {
			state: sync.SyncState.Idle,
			active: 0,
			failed: 0,
			updated: 1,
			total: 1
		});

		progressUpdates = [];
		return env.syncer.syncItems();
	}).then(() => {
		assert.deepEqual(progressUpdates, [{
			state: sync.SyncState.ListingItems,
			active: 0,
			failed: 0,
			updated: 0,
			total: 0
		}, {
				state: sync.SyncState.SyncingItems,
				active: 0,
				failed: 0,
				updated: 0,
				total: 0
			}, {
				state: sync.SyncState.Idle,
				active: 0,
				failed: 0,
				updated: 0,
				total: 0
			}]);
	});
});

testLib.addAsyncTest('sync deleted items', (assert) => {
	var env: Env;
	var item: item_store.Item;

	return setupWithItem().then((_env) => {
		env = _env.env;
		item = _env.item;

		// sync item to local store
		return env.syncer.syncItems();
	}).then(() => {

		// remove it in the cloudStore
		return item.remove();
	}).then(() => {

		// sync again
		return env.syncer.syncItems();
	}).then(() => {
		return env.localStore.listItems({ includeTombstones: true });
	}).then((items) => {

		// verify that the store item was also
		// deleted
		assert.equal(items.length, 1);
		assert.ok(items[0].isTombstone());
	});
});

testLib.addAsyncTest('syncing locked store should fail', (assert) => {
	var env: Env;
	var item: item_store.Item;

	return setupWithItem().then(_env => {
		env = _env.env;
		item = _env.item;
		return env.keyAgent.forgetKeys()
	}).then(() => {
		return env.keyAgent.listKeys();
	}).then(keys => {
		return asyncutil.result(env.syncer.syncItems());
	}).then(result => {
		assert.ok(result.error != null);
	});
});

testLib.addAsyncTest('repeat sync', (assert) => {
	return setupWithItem().then((env) => {
		// syncing whilst a sync is already in progress should return
		// the same promise
		var synced = env.env.syncer.syncItems();
		var synced2 = env.env.syncer.syncItems();
		assert.equal(synced, synced2);
		return synced2;
	});
});

testLib.addAsyncTest('sync many items', (assert) => {
	var ITEM_COUNT = 100;
	var env: Env;

	return setup().then((_env) => {
		env = _env;

		var saves: Q.Promise<void>[] = [];
		while (saves.length < ITEM_COUNT) {
			var item = new item_builder.Builder(item_store.ItemTypes.LOGIN)
			.setTitle('sync me ' + saves.length)
			.addLogin('testuser' + saves.length + '@gmail.com')
			.addUrl('signon.acme.org')
			.item();
			saves.push(item.saveTo(env.cloudStore));
		}

		return Q.all(saves);
	}).then(() => {
		return env.syncer.syncItems();
	}).then(() => {
		return env.localStore.listItems();
	}).then((items) => {
		assert.equal(items.length, ITEM_COUNT, 'synced expected number of items');
	});
});
