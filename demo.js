// @ts-check

var largeSizeThreshold = 60 * 1000;
var batchSize = largeSizeThreshold / 2;
var contextCodeQuoteLength = 35;
var parseExtensions =
  ['.ts', '.tsx', '.d.ts'];
  // ['.ts', '.tsx', '.d.ts', '.js', '.json'];

var requestSyntacticDiagnosticOnEachStep = false;
var requestSemanticDiagnosticOnEachStep = false;

logTimed('Loading TypeScript library...');
var ts = require('./lib/typescript');
logTimed('...at ' + require.resolve('./lib/typescript'));

var projectRoot = process.argv.length > 2 ? ts.sys.resolvePath(process.argv[2]) :
  ts.sys.resolvePath(require.resolve('./lib/typescript') + '../../..');

logTimed('Project root at ' + projectRoot);

var settings = ts.getDefaultCompilerOptions();
settings.allowJs = true;
settings.checkJs = true;
settings.resolveJsonModule = true;

/** @typedef {{
 *  version?: number,
 *  text?: string,
 * } & import('./lib/typescript').IScriptSnapshot}  VScriptSnapshot */
/** @type {{ [absoluteFilePath: string]: VScriptSnapshot }} */
var scripts = {};

logTimed('Creating LanguageServiceHost...');
/** @type {import('./lib/typescript').LanguageServiceHost} */
var lsHost = {
  getCompilationSettings: function () { return settings; },
  getScriptFileNames: function () { return Object.keys(scripts); },
  getScriptVersion: function (fileName) { return scripts[fileName] && String(scripts[fileName].version || ''); },
  getScriptSnapshot: function (fileName) { return scripts[fileName]; },
  getCurrentDirectory: function () { return projectRoot; },
  getDefaultLibFileName: function (options) {
    const name = ts.getDefaultLibFileName(options);
    return name;
  }
};

logTimed('Creating LanguageService...');
var langService = ts.createLanguageService(lsHost);

logTimed('Enumerating directory...');
var allFiles = ts.sys.readDirectory(
  projectRoot,
  parseExtensions);
logTimed('...' + allFiles.length + ' found.');


logTimed('Loading...');
var lastFileLoadReport = Date.now();
var previousTimes;
for (var indexOfFile = 0; indexOfFile < allFiles.length; indexOfFile++) {
  previousTimes = loadNextFile(indexOfFile, previousTimes);
}

/** @typedef {{ 
 *  indexOfFile: number, 
 *  fileName: string,
 *  fileLoadStart: number,
 *  fileLoadEnd?: number,
 *  size?: number,
 *  text?: string,
 *  snapshot?: VScriptSnapshot,
 *  syntDiag?: import('./lib/typescript').Diagnostic[],
 *  semDiag1?: import('./lib/typescript').Diagnostic[],
 *  semDiag2?: import('./lib/typescript').Diagnostic[],
 *  complets?: import('./lib/typescript').WithMetadata<import('./lib/typescript').CompletionInfo>,
 *  toString(): string
 * }} FileDesc */

/**
 * @param {number} indexOfFile 
 * @param {FileDesc} previousTimes 
 * @returns {FileDesc}
 */
function loadNextFile(indexOfFile, previousTimes) {
  var fileName = allFiles[indexOfFile];

  /** @type {FileDesc} */
  var times = {
    indexOfFile: indexOfFile,
    fileName: fileName,
    fileLoadStart: Date.now(),
    toString: timeToString
  };

  // if previous didn't report AND next load will be large, show that context
  times.size = ts.sys.getFileSize(fileName);
  var anticipateLargeFile = times.size > largeSizeThreshold;
  if (anticipateLargeFile) {
    if (previousTimes)
      logTimed(previousTimes.toString());

    loadLargeFile(times);
    return;
  }
  else {
    loadSmallFile(times);

    if (times.fileLoadEnd - lastFileLoadReport > 200 ||
      times.fileLoadEnd - times.fileLoadStart > 600) {
      logTimed(times.toString());
      return;
    }

    return times;
  }
}

/**
 * @param {FileDesc} fileDesc 
 */
function loadSmallFile(fileDesc) {
  fileDesc.text = ts.sys.readFile(fileDesc.fileName);
  recordFileTiming(fileDesc, 'read');

  /** @type {VScriptSnapshot} */
  fileDesc.snapshot = ts.ScriptSnapshot.fromString(fileDesc.text);

  fileDesc.snapshot.version = 0;
  scripts[fileDesc.fileName] = fileDesc.snapshot;

  revalidateFile(fileDesc);
}

/**
 * @param {FileDesc} fileDesc
 */
function revalidateFile(fileDesc) {
  if (requestSyntacticDiagnosticOnEachStep) {
    fileDesc.syntDiag = langService.getSyntacticDiagnostics(fileDesc.fileName);
    recordFileTiming(fileDesc, 'syntx');
  }

  if (requestSemanticDiagnosticOnEachStep) {
    fileDesc.semDiag1 = langService.getSemanticDiagnostics(fileDesc.fileName);
    recordFileTiming(fileDesc, 'sem1');

    fileDesc.semDiag2 = langService.getSemanticDiagnostics(fileDesc.fileName);
    recordFileTiming(fileDesc, 'sem2');
  }

  var completionsPos =
    ((fileDesc.snapshot && fileDesc.snapshot.text ? fileDesc.snapshot.text.length : fileDesc.text.length) / 2) | 0;

  fileDesc.complets = langService.getCompletionsAtPosition(fileDesc.fileName, completionsPos, {});
  recordFileTiming(fileDesc, 'comp');
}

/**
 * @param {FileDesc} fileDesc
 */
function loadLargeFile(fileDesc) {
  fileDesc.text = ts.sys.readFile(fileDesc.fileName);
  recordFileTiming(fileDesc, 'read');

  logTimed(
    fileDescHeadToString(fileDesc) + ' ' +
    formatSizeWithBlue(Math.round(fileDesc.size / 1000), 'K'));

  while (true) {
    var addStart = fileDesc.snapshot ? fileDesc.snapshot.text.length : 0;

    var addEnd = findBestChunkEnd(addStart, fileDesc.text);
    
    var addChunk = fileDesc.text.slice(addStart, addEnd);
    scripts[fileDesc.fileName] = fileDesc.snapshot = partialSnapshot(addChunk, fileDesc.snapshot);

    revalidateFile(fileDesc);

    var contextText = tryPrintContext(fileDesc.fileName, addStart, addChunk);

    logTimed(
      '                 +' + formatSizeWithBlue(Math.round((addEnd - addStart) / 1000), 'K') +
      (addStart >= fileDesc.text.length ? '/end' : '') + ' ...' +
      timeTailToString(fileDesc) +
      (contextText ? '\n' + contextText : ''));

    if (addEnd >= fileDesc.text.length)
      break;
  }
}

function formatSizeWithBlue(size, suffix) {
  var sizeStr = String(size);
  return '\x1b[36m' + sizeStr.slice(0, Math.max(0, sizeStr.length - 3)) +
    '\x1b[34m' + sizeStr.slice(-3) + (suffix ? '\x1b[36m' + suffix : '') + '\x1b[0m';
}


/**
 * @param {string} fileName
 * @param {number} addStart
 * @param {string} addChunk 
 */
function tryPrintContext(fileName, addStart, addChunk) {
  var firstLineMatch = /^\s*[\s\S][\s\S][\s\S]\s*\S[^\n\r]*[\n\r]/.exec(addChunk);
  var lastLineMatch = /[\n\r]*[^\n\r]*\s*[\s\S][\s\S][\s\S]\s*$/.exec(addChunk);
  if (firstLineMatch && lastLineMatch) {
    var firstLine = firstLineMatch[0].replace(/^\s+/, '').replace(/\s+$/, '').replace(/[\r\n]/g, ' ');
    var lastLine = lastLineMatch[0].replace(/^\s+/, '').replace(/\s+$/, '').replace(/[\r\n]/g, ' ');
    if (firstLine.length > contextCodeQuoteLength)
      firstLine = firstLine.slice(0, contextCodeQuoteLength);
    if (lastLine.length > contextCodeQuoteLength)
      lastLine = lastLine.slice(-contextCodeQuoteLength);
    if (firstLine.length && lastLine.length) {
      var prog = langService.getProgram();
      var file = prog && prog.getSourceFile(fileName);
      var firstLineStart = addStart + addChunk.indexOf(firstLine.charAt(0));
      var firstLineNum = file && file.getLineAndCharacterOfPosition(firstLineStart).line + 1;
      var lastLineEnd = addStart + addChunk.lastIndexOf(lastLine.charAt(lastLine.length - 1));
      var lastLineNum = file && file.getLineAndCharacterOfPosition(lastLineEnd).line + 1;
      return (
        '        ' + (firstLineNum ? 'L' + firstLineNum + ' ' : '') + ' \x1b[90m' + firstLine + '\x1b[0m  ... ' +
        '\x1b[90m' + lastLine + '\x1b[0m' +
        (lastLineNum ? ' L' + lastLineNum +
          '\x1b[90m+' + formatSizeWithBlue(lastLineNum - firstLineNum) + '\x1b[0m ' :
          '')
      );
    }
  }
}

/**
 * @param {number} chunkStart
 * @param {string | string[]} text
 */
function findBestChunkEnd(chunkStart, text) {
  var chunkEnd = chunkStart + Math.min(batchSize, (text.length - chunkStart) / 2);
  //  closing bracket at the start of the line is probably a safe breaking point
  // (except look for a next newline after, for the sake of IIFE)
  var bracketMatch = text.indexOf('\n}', chunkEnd);
  var newLineAfterBracket = bracketMatch < 0 ? -1 : text.indexOf('\n', bracketMatch + 2);
  var chunkEnd = newLineAfterBracket >= 0 ? newLineAfterBracket : text.length;
  // sometimes the safe chunk is just too large, go unsafe
  if (chunkEnd - chunkStart > batchSize * 4) {
    if (bracketMatch > 0 && bracketMatch - chunkStart < batchSize * 4) {
      chunkEnd = bracketMatch + 1;
    }
    else {
      chunkEnd = text.indexOf('}', chunkStart + batchSize);
      if (chunkEnd < 0 || chunkEnd - chunkStart > batchSize * 4)
        chunkEnd = chunkStart + batchSize;
    }
  }
  return chunkEnd;
}

function partialSnapshot(text, prevSnapshot) {
  var updated = {
    text: prevSnapshot ? prevSnapshot.text + text : text,
    version: prevSnapshot ? prevSnapshot.version +1 : 0,
    getText: partialSnapshot_getText,
    getLength: partialSnapshot_getLength,
    getChangeRange: partialSnapshot_getChangeRange
  };

  return updated;
}

function partialSnapshot_getText(start, end) {
  return this.text.slice(start, end);
}

function partialSnapshot_getLength() {
  return this.text.length;
}

function partialSnapshot_getChangeRange(oldSnapshot) {
  return {
    span: { start: oldSnapshot.text.length, length: 0 },
    newLength: this.text.length - oldSnapshot.text.length
  };
}


function fileDescHeadToString(fileDesc) {
  var shortFileName = fileDesc.fileName.slice(projectRoot.length);
  return (
    fileDesc.indexOfFile + ') ' +
    shortFileName +
    ' read:' + fileDesc.read
  );
}

function timeTailToString(fileDesc) {
  return (
    (requestSyntacticDiagnosticOnEachStep ?
      ' syntx:' + fileDesc.syntx : '') +
    (requestSemanticDiagnosticOnEachStep ?
      ' sem1:' + fileDesc.sem1 + '/' + fileDesc.sem2 : '') +
    ' comp:' + fileDesc.comp +
    (fileDesc.complets && fileDesc.complets.entries && fileDesc.complets.entries.length &&
      '\x1b[32m~' + fileDesc.complets.entries.length + '*' +
      fileDesc.complets.entries[Math.min(2, fileDesc.complets.entries.length - 1)].name +
      '\x1b[0m' || '')
  );
}

function timeToString() {
  return fileDescHeadToString(this) + timeTailToString(this);
}

function recordFileTiming(outcome, name) {
  var now = Date.now();
  outcome[name] = now - (outcome.fileLoadEnd || outcome.fileLoadStart);
  outcome.fileLoadEnd = now;
}

function logTimed() {
  var now = Date.now();
  var passedMs = (now - /** @type {*} */(logTimed).lastWrite);
  var passed = ('        '  + (passedMs >= 0 ? String(passedMs) : 'start')).slice(-6);
  if (passedMs > 400) passed = passed;
  else if (passedMs >= 0) passed = '\x1b[90m' + passed + '\x1b[0m';
  /** @type {*} */(logTimed).lastWrite = now;

  var args = [passed];
  for (var i = 0; i < arguments.length; i++) {
    args.push(arguments[i]);
  }
  console.log.apply(console, args);
}
