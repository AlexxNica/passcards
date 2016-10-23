
import assert = require('assert');
var cryptoJS = require('crypto-js');
import node_crypto = require('crypto');
import uuid = require('node-uuid');

import { btoa } from './base/stringutil';
import agile_keychain_entries = require('./agile_keychain_entries');
import crypto = require('./base/crypto');
import crypto_worker = require('./crypto_worker');
import key_agent = require('./key_agent');
import pbkdf2Lib = require('./crypto/pbkdf2');
import rpc = require('./net/rpc');
import { defer, Deferred, nodeResolver } from '../lib/base/promise_util';
import { bufferFromString, stringFromBuffer } from './base/collectionutil';

export class AESKeyParams {
	constructor(public key: string, public iv: string) {
	}
}

export class SaltedCipherText {
	constructor(public salt: string, public cipherText: string) {
	}
}

/** Generate encryption keys for an Agile Keychain vault from
  * a given password.
  *
  * This function generates a new random 1024-byte encryption key
  * for a vault and encrypts it using a key derived from @p password
  * using @p passIterations iterations of PBKDF2.
  */
export function generateMasterKey(password: string, passIterations: number): Promise<agile_keychain_entries.EncryptionKeyList> {
	let masterKey = crypto.randomBytes(1024);
	let salt = crypto.randomBytes(8);

	return key_agent.keyFromPassword(password, salt, passIterations).then(derivedKey => {
		return key_agent.encryptKey(derivedKey, masterKey);
	}).then(encryptedKey => {
		let masterKeyEntry = {
			data: btoa('Salted__' + salt + encryptedKey.key),
			identifier: newUUID(),
			iterations: passIterations,
			level: 'SL5',
			validation: btoa(encryptedKey.validation)
		};

		return <agile_keychain_entries.EncryptionKeyList>{
			list: [masterKeyEntry],
			SL5: masterKeyEntry.identifier
		};
	});
}

export function extractSaltAndCipherText(input: string): SaltedCipherText {
	if (input.slice(0, 8) != 'Salted__') {
		throw 'Ciphertext missing salt';
	}
	var salt = input.substring(8, 16);
	var cipher = input.substring(16);
	return new SaltedCipherText(salt, cipher);
}

/** Derives an AES-128 key and initialization vector from a key of arbitrary length and salt
  * using.
  */
export async function openSSLKey(cryptoImpl: Crypto, password: string, salt: string): Promise<AESKeyParams> {
	var data = password + salt;
	var key = await cryptoImpl.md5Digest(data);
	var iv = await cryptoImpl.md5Digest(key + data);
	return new AESKeyParams(key, iv);
}

/** Encrypt the JSON data for an item for storage in the Agile Keychain format. */
export async function encryptAgileKeychainItemData(cryptoImpl: Crypto, key: string, plainText: string) {
	var salt = crypto.randomBytes(8);
	var keyParams = await openSSLKey(cryptoImpl, key, salt);
	return cryptoImpl.aesCbcEncrypt(keyParams.key, plainText, keyParams.iv).then(encrypted => {
		return 'Salted__' + salt + encrypted;
	});
}

/** Decrypt the encrypted contents of an item stored in the Agile Keychain format. */
export async function decryptAgileKeychainItemData(cryptoImpl: Crypto, key: string, cipherText: string) {
	var saltCipher = extractSaltAndCipherText(cipherText);
	var keyParams = await openSSLKey(cryptoImpl, key, saltCipher.salt);
	return cryptoImpl.aesCbcDecrypt(keyParams.key, saltCipher.cipherText, keyParams.iv);
}

/** Generate a V4 (random) UUID string in the form used
  * by items in an Agile Keychain:
  * - There are no hyphen separators between parts of the UUID
  * - All chars are upper case
  */
export function newUUID(): string {
	return uuid.v4().toUpperCase().replace(/-/g, '');
}

/** Crypto is an interface to common crypto algorithms required
  * to decrypt Agile Keychain vaults.
  */
export interface Crypto {
	/** Decrypt @p cipherText using AES-128 with the given key and initialization vector.
	  */
	aesCbcDecrypt(key: string, cipherText: string, iv: string): Promise<string>;
	aesCbcEncrypt(key: string, plainText: string, iv: string): Promise<string>;

	/** Derive a key of length @p keyLen from a password using @p iterCount iterations
	  * of PBKDF2
	  */
	pbkdf2(masterPwd: string, salt: string, iterCount: number, keyLen: number): Promise<string>;

	md5Digest(input: string): Promise<string>;
}

// crypto implementation using Node.js' crypto lib
export class NodeCrypto implements Crypto {
	aesCbcDecrypt(key: string, cipherText: string, iv: string) {
		var keyBuf = new Buffer(key, 'binary');
		var ivBuf = new Buffer(iv, 'binary');
		var decipher = node_crypto.createDecipheriv('AES-128-CBC', keyBuf, ivBuf);
		let result = '';
		result += decipher.update(cipherText, 'binary', 'binary');
		result += decipher.final('binary');
		return Promise.resolve<string>(result);
	}

	aesCbcEncrypt(key: string, plainText: string, iv: string): Promise<string> {
		var keyBuf = new Buffer(key, 'binary');
		var ivBuf = new Buffer(iv, 'binary');
		var cipher = node_crypto.createCipheriv('AES-128-CBC', keyBuf, ivBuf);
		var result = '';
		result += cipher.update(plainText, 'binary', 'binary');
		result += cipher.final('binary');
		return Promise.resolve(result);
	}

	pbkdf2Sync(masterPwd: string, salt: string, iterCount: number, keyLen: number): string {
		var derivedKey = node_crypto.pbkdf2Sync(masterPwd, salt, iterCount, keyLen);
		return derivedKey.toString('binary');
	}

	pbkdf2(masterPwd: string, salt: string, iterCount: number, keyLen: number): Promise<string> {
		var key = defer<string>();
		// FIXME - Type definition for crypto.pbkdf2() is wrong, result
		// is a Buffer, not a string.
		node_crypto.pbkdf2(masterPwd, salt, iterCount, keyLen, (err, derivedKey) => {
			if (err) {
				key.reject(err);
				return;
			}
			key.resolve((<any>derivedKey).toString('binary'));
		});
		return key.promise;
	}

	async md5Digest(input: string): Promise<string> {
		var md5er = node_crypto.createHash('md5');
		md5er.update(input);
		return md5er.digest('binary');
	}
}

interface WorkerAndRpc {
	worker: Worker;
	rpc: rpc.RpcHandler;
}

// crypto implementation using CryptoJS plus the
// crypto functions in lib/crypto
export class CryptoJsCrypto implements Crypto {
	static workers: WorkerAndRpc[];
	encoding: any

	/** Setup workers for async encryption tasks
	  */
	static initWorkers() {
		if (typeof Worker != 'undefined') {
			var script = crypto_worker.SCRIPT_PATH;

			CryptoJsCrypto.workers = [];
			for (var i = 0; i < 2; i++) {
				var worker = new Worker(script);
				var rpcHandler = new rpc.RpcHandler(new rpc.WorkerMessagePort(worker, 'crypto-worker', 'passcards'));
				CryptoJsCrypto.workers.push({
					worker: worker,
					rpc: rpcHandler
				});
			}
		}
	}

	constructor() {
		this.encoding = cryptoJS.enc.Latin1;
	}

	aesCbcEncrypt(key: string, plainText: string, iv: string): Promise<string> {
		assert.equal(key.length, 16);
		assert.equal(iv.length, 16);

		var keyArray = this.encoding.parse(key);
		var ivArray = this.encoding.parse(iv);
		var plainArray = this.encoding.parse(plainText);
		var encrypted = cryptoJS.AES.encrypt(plainArray, keyArray, {
			mode: cryptoJS.mode.CBC,
			padding: cryptoJS.pad.Pkcs7,
			iv: ivArray
		});
		return Promise.resolve(encrypted.ciphertext.toString(this.encoding));
	}

	aesCbcDecrypt(key: string, cipherText: string, iv: string) {
		assert.equal(key.length, 16);
		assert.equal(iv.length, 16);

		var keyArray = this.encoding.parse(key);
		var ivArray = this.encoding.parse(iv);
		var cipherArray = this.encoding.parse(cipherText);
		var cipherParams = cryptoJS.lib.CipherParams.create({
			ciphertext: cipherArray
		});
		let result = cryptoJS.AES.decrypt(cipherParams, keyArray, {
			mode: cryptoJS.mode.CBC,
			padding: cryptoJS.pad.Pkcs7,
			iv: ivArray
		}).toString(this.encoding);
		return Promise.resolve(result);
	}

	/** Derive a key from a password using PBKDF2. Depending on the number of iterations,
	  * this process can be expensive and can block the UI in the browser.
	  */
	pbkdf2Sync(pass: string, salt: string, iterCount: number, keyLen: number): string {
		// CryptoJS' own implementation of PKBDF2 scales poorly as the number
		// of iterations increases (see https://github.com/dominictarr/crypto-bench/blob/master/results.md)
		//
		// Current versions of 1Password use 80K iterations of PBKDF2 so this needs
		// to be fast to be usable, especially on mobile devices.
		//
		// Hence we use a custom implementation of PBKDF2 based on Rusha

		var pbkdf2Impl = new pbkdf2Lib.PBKDF2();
		var passBuf = bufferFromString(pass);
		var saltBuf = bufferFromString(salt);
		var key = pbkdf2Impl.key(passBuf, saltBuf, iterCount, keyLen);
		return stringFromBuffer(key);
	}

	/** Derive a key from a password using PBKDF2. If initWorkers() has been called,
	  * this will run asynchronously and in parallel in a worker, otherwise it will fall back to
	  * pbkdf2Sync()
	  */
	pbkdf2(pass: string, salt: string, iterCount: number, keyLen: number): Promise<string> {
		if (CryptoJsCrypto.workers) {
			var keyBlocks: Promise<string>[] = [];
			var PBKDF2_BLOCK_SIZE = 20;
			var blockCount = Math.round(keyLen / PBKDF2_BLOCK_SIZE);

			var processBlock = (blockIndex: number, keyBlock: Deferred<string>) => {
				var rpc = CryptoJsCrypto.workers[blockIndex % CryptoJsCrypto.workers.length].rpc;
				rpc.call('pbkdf2Block', [pass, salt, iterCount, blockIndex], nodeResolver(keyBlock));
			};

			for (var blockIndex = 0; blockIndex < blockCount; blockIndex++) {
				var keyBlock = defer<string>();
				processBlock(blockIndex, keyBlock);
				keyBlocks.push(keyBlock.promise);
			}

			return Promise.all(keyBlocks).then((blocks) => {
				return blocks.join('').slice(0, keyLen);
			});
		} else {
			// fall back to sync calculation
			return Promise.resolve(this.pbkdf2Sync(pass, salt, iterCount, keyLen));
		}
	}

	async md5Digest(input: string): Promise<string> {
		return cryptoJS.MD5(this.encoding.parse(input)).toString(this.encoding);
	}
}

declare global {
	interface Crypto {
		// Prefixed implementation of SubtleCrypto in Safari
		// See https://blog.engelke.com/2015/03/02/apples-safari-browser-and-web-cryptography/
		webkitSubtle: SubtleCrypto;
	}
}

let subtleCrypto: SubtleCrypto;

if (typeof window !== 'undefined' && window.crypto) {
	subtleCrypto = window.crypto.subtle || window.crypto.webkitSubtle;
}

/**
  * Implements the Crypto interface using the Web Cryptography API
  * See https://www.w3.org/TR/WebCryptoAPI/
  */
class WebCrypto implements Crypto {
	private crypto: SubtleCrypto;

	constructor() {
		this.crypto = subtleCrypto;
	}

	async aesCbcDecrypt(key: string, cipherText: string, iv: string) {
		const cryptoKey = await this.crypto.importKey('raw', bufferFromString(key),
			'AES-CBC', false, ['decrypt']);
		const decrypted = await this.crypto.decrypt({name: 'AES-CBC', iv: bufferFromString(iv)},
			cryptoKey, bufferFromString(cipherText));
		return stringFromBuffer(new Uint8Array(decrypted));
	}

	async aesCbcEncrypt(key: string, plainText: string, iv: string) {
		const cryptoKey = await this.crypto.importKey('raw', bufferFromString(key),
			'AES-CBC', false, ['encrypt']);
		const encrypted = await this.crypto.encrypt({name: 'AES-CBC', iv: bufferFromString(iv)},
			cryptoKey, bufferFromString(plainText));
		return stringFromBuffer(new Uint8Array(encrypted));
	}

	async pbkdf2(masterPwd: string, salt: string, iterCount: number, keyLen: number) {
		const masterKey = await this.crypto.importKey('raw', bufferFromString(masterPwd),
			'PBKDF2', false, ['deriveKey']);
		const derived = await this.crypto.deriveKey({
			name: 'PBKDF2',
			salt: bufferFromString(salt),
			iterations: iterCount,
			hash: 'SHA-1',
		}, masterKey, {name: 'AES-CBC', length: 256}, true /* extractable */, ['encrypt', 'decrypt']);
		const extracted = await this.crypto.exportKey('raw', derived);
		return stringFromBuffer(new Uint8Array(extracted));
	}

	async md5Digest(input: string) {
		// WebCrypto does not support MD5 :(
		const encoding = cryptoJS.enc.Latin1;
		return cryptoJS.MD5(encoding.parse(input)).toString(encoding);
	}
}

export var defaultCrypto: Crypto;

if (subtleCrypto) {
	defaultCrypto = new WebCrypto;
} else {
	defaultCrypto = new CryptoJsCrypto;
}

