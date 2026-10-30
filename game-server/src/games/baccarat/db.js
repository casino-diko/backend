'use strict';

/*
 |--------------------------------------------------------------------------
 | baccarat models
 |--------------------------------------------------------------------------
 | Game collections live in the baccarat database, dealers / users /
 | vendors / maintenance / notice / rooms in the shared one.
 |
 */

module.exports = require('../../core/models').forGame('baccarat');
