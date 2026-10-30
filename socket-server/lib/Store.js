/**
 *
 * @type {exports|module.exports}
 *
 * @author Joseph Dan B. Alinsug <josephdanalinsug@hotmail.com>
 */
const _ = require('lodash');
const Redis = require('ioredis');
const conf = require('../config');

const client = new Redis(conf.redis.client);

client.on('error', (error) => console.log(`[Store] redis error: ${error.message}`));

module.exports = {
    // shared ioredis connection, also used for publishing
    client,

    /**
     * @returns {boolean} true when the redis connection is usable
     */
    isReady () {
        return client.status === 'ready';
    },

    /**
     *
     * @param namespace
     * @param data
     * @returns {*}
     */
    update (namespace, ...data) {
        _.forEach(data[0], (row, key) => {
            data[0][key] = _.isObject(row) || _.isNull(row) && !_.isFunction(row)
              ? JSON.stringify(row)
              : (row === undefined ? '' : row);
        });

        return client.hmset(namespace, ...data);
    },

    /**
     *
     * @param namespace
     */
    getAllUnserialized (namespace) {
       return client.hgetall(namespace).then((data) => {
           _.forEach(data, (row, key) => {
                data[key] = this.parse(row);
           });

           return data;
       });
    },

    /**
     *
     * @param namespace
     * @param field
     */
    getFieldUnserialized (namespace, field) {
       return client.hmget(namespace, field).then((data) => {
           return this.parse(data);
       });
    },

    /**
     *
     * @param cursor
     * @returns {*}
     */
    getAllHashes (cursor = '0') {
        return client.scan(cursor, 'MATCH', '*/*', 'COUNT', '10000');
    },

    /**
     * @desc Perform hdel asynchronously
     * @param namespace
     * @param key
     * @returns {*}
     */
    hdel (namespace, key) {
        return client.hdel(namespace, key);
    },

   /**
    *  Delete Namespace
    *
    * @param namespace
    * @returns {*}
    */
    del (namespace) {
        return client.del(namespace);
    },

    /**
     *
     * @param namespace
     * @param cursor
     * @param pattern
     * @param count
     * @returns {*}
     */
    async hscan (namespace, cursor, pattern, count = 10000) {
        return client.hscan(namespace, cursor, 'MATCH', pattern, 'COUNT', count);
    },

    /**
     * @desc Iterate the full cursor of an HSCAN and return all matched fields as an object
     *
     * @param namespace
     * @param pattern
     * @returns {Promise<Object>}
     */
    async hscanAll (namespace, pattern) {
        let result = {};
        let cursor = '0';

        do {
            let [next, rows] = await client.hscan(namespace, cursor, 'MATCH', pattern, 'COUNT', 1000);
            Object.assign(result, this.buildKeyValue(rows));
            cursor = next;
        } while (cursor !== '0');

        return result;
    },

    /**
     *
     * @param namespace
     * @param cursor
     * @param count
     */
    async scan (namespace, cursor = 0, count = 1000000) {
        return client.scan(cursor, 'MATCH', namespace, 'COUNT', count);
    },

    /**
     *
     * @param data
     * @returns {*}
     */
    parse (data) {
        let temp = null;

        try {
            temp = JSON.parse(data);
        }
        catch (error) {
            temp = data;
        }

        return temp;
    },

    hgetall (namespace) {
        return client.hgetall(namespace);
    },

    /**
     *
     * @param params
     */
    buildKeyValue (params) {
        let object = {};
        for (let i = 0; i < params.length; i += 2) {
            object[params[i]] = params[i + 1];
        }

        return object;
    },

    /**
     * @desc Socket id of the most recent registration of a user in the `all` hash
     * Fields are `${APP_NAME}:${userId}:${socketId}`, value is the worker pid
     *
     * @param {Array} rows raw HSCAN rows [field, value, field, value, ...]
     * @returns {{socketId: (String|null), pid: (Number|null)}}
     */
    lastRegistration (rows = []) {
        if (rows.length < 2) {
            return {socketId: null, pid: null};
        }

        let field = rows[rows.length - 2];

        return {
            socketId: field.split(':').pop(),
            pid: parseInt(rows[rows.length - 1]) || null
        };
    },

    /**
     * Close the redis connection
     */
    quit () {
        return client.quit().catch(() => client.disconnect());
    }
};
