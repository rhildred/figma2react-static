var readlineSync = require('readline-sync');
var fs = require('fs');

var sFileToken = readlineSync.question('FileToken: ');
var sDevToken = readlineSync.question('DevToken: ');

fs.writeFileSync(".env", `DEV_TOKEN=${sDevToken}\nFILE_KEY=${sFileToken}\n`);

