'use strict';

// colour theme used by the log statements (`'text'.info`, `'text'.error`, ...)
const colors = require('colors');

colors.setTheme({
	silly   : 'rainbow',
	input   : 'grey',
	verbose : 'cyan',
	prompt  : 'grey',
	info    : 'green',
	data    : 'grey',
	help    : 'cyan',
	warn    : 'yellow',
	debug   : 'blue',
	error   : 'red'
});

module.exports = colors;
