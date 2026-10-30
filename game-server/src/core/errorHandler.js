'use strict';

/*
 |--------------------------------------------------------------------------
 | errorHandler
 |--------------------------------------------------------------------------
 | Records failed dealer actions in the game's `dealer_fail_logs`
 | collection (one document per table + round).
 |
 */

module.exports = (models) => async (dealerSocket, eventName) => {
	const data = dealerSocket || {};
	console.log(`[${data.gameName}] table ${data.tableId} round ${data.roundNum}: ${eventName}`.error);

	if (data.tableId === null || data.tableId === undefined) return;

	try {
		const filter = { table_id : parseInt(data.tableId), round_num : parseInt(data.roundNum) || 0 };
		const action = { action : 'insert', comment : String(eventName), time : new Date() };
		const exists = await models.dealerFailLogs.exists(filter);

		if (exists) {
			await models.dealerFailLogs.updateOne(filter, {
				$set  : { real_name : data.realName || null },
				$push : { actions : action }
			});
		} else {
			await models.dealerFailLogs.create(Object.assign({
				_id       : await models.nextId('dealer_fail_logs'),
				real_name : data.realName || null,
				actions   : [action]
			}, filter));
		}
	} catch (e) {
		console.log(`could not write dealer_fail_logs: ${e.message}`.error);
	}
};
