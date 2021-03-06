const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { google } = require('googleapis');

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const WITH_FORMULA = true;
const SPREADSHEET_ID = '1nf8JS4YqphnWH-fBBlSMCmq18OC4HsTA7bOJ5nlNjDY';
const TOKEN_PATH = path.join(process.env.HOME, 'gtoken.json');
const CREDS_PATH = path.join(process.env.HOME, 'gcredentials.json');

function run(cb) {
  // Load client secrets from a local file.
  fs.readFile(CREDS_PATH, (err, content) => {
    if (err) return console.log('Error loading client secret file:', err);
    // Authorize a client with credentials, then call the Google Sheets API.
    authorize(JSON.parse(content), cb);
  });
}

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
function authorize(credentials, callback) {
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0],
  );

  // Check if we have previously stored a token.
  fs.readFile(TOKEN_PATH, (err, token) => {
    if (err) return getNewToken(oAuth2Client, callback);
    oAuth2Client.setCredentials(JSON.parse(token));
    callback(oAuth2Client);
  });
}

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback for the authorized client.
 */
function getNewToken(oAuth2Client, callback) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url:', authUrl);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('Enter the code from that page here: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err)
        return console.error(
          'Error while trying to retrieve access token',
          err,
        );
      oAuth2Client.setCredentials(token);
      // Store the token to disk for later program executions
      fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
        if (err) return console.error(err);
        console.log('Token stored to', TOKEN_PATH);
      });
      callback(oAuth2Client);
    });
  });
}

async function exportToGoogleSheet(auth) {
  const { bundles } = require(path.resolve('./src/locales/index.js'));

  const sheets = google.sheets({ version: 'v4', auth });

  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
  });

  const fetchedSheets = spreadsheet.data.sheets;

  for (var sheet of fetchedSheets) {
    if (sheet.properties.sheetId > 0) {
      await deleteSheet(sheets, sheet.properties.sheetId);
    }
  }

  const locales = Object.keys(bundles);
  const enLocale = require(path.resolve('./src/locales/en'));
  const otherLocales = locales
    .filter((l) => l !== 'en')
    .map((l) => ({
      locale: l,
      translations: require(path.resolve('./src/locales/' + l)),
    }));

  const data = await createSheet(sheets, 'en');
  await writeData(sheets, data.sheetId, [
    ['key', 'en'],
    ...Object.keys(enLocale)
      .sort()
      .map((key) => {
        return [key, enLocale[key]];
      }),
  ]);
  await autoResize(sheets, data.sheetId);

  for (var l of otherLocales) {
    const { sheetId } = await createSheet(sheets, l.locale);
    await writeData(sheets, sheetId, [
      ['key', 'en', l.locale],
      ...Object.keys(enLocale)
        .sort()
        .map((key) => {
          return [
            key,
            enLocale[key],
            l.translations[key] ||
              (WITH_FORMULA
                ? `=GOOGLETRANSLATE(indirect("B" & row()),"en", "${l.locale}")`
                : ''),
            ...(WITH_FORMULA && !l.translations[key] ? ['auto translation'] : []),
          ];
        }),
    ]);
    await autoResize(sheets, sheetId);
  }

  return spreadsheet.data.sheets;
}

async function createSheet(sheets, title) {
  const r = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    resource: {
      requests: [
        {
          addSheet: {
            properties: {
              title,
            },
          },
        },
      ],
    },
  });
  return r.data.replies[0].addSheet.properties;
}

async function deleteSheet(sheets, sheetId) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    resource: {
      requests: [
        {
          deleteSheet: {
            sheetId: sheetId,
          },
        },
      ],
    },
  });
}

async function writeData(sheets, sheetId, data) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    resource: {
      requests: [
        {
          updateCells: {
            range: {
              sheetId: sheetId,
            },
            fields: '*',
            rows: data.map((row) => {
              return {
                values: row.map((r) => {
                  return r.startsWith('=')
                    ? {
                        userEnteredValue: {
                          formulaValue: r,
                        },
                      }
                    : {
                        userEnteredValue: {
                          stringValue: r,
                        },
                      };
                }),
              };
            }),
          },
        },
      ],
    },
  });
}

async function autoResize(sheets, sheetId) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    resource: {
      requests: [
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId: sheetId,
              dimension: 'COLUMNS',
            },
          },
        },
      ],
    },
  });
}

async function importFromGoogleSheet(auth) {
  const sheets = google.sheets({ version: 'v4', auth });
  const { bundles } = require(path.resolve('./src/locales/index.js'));
  const noEnLocales = Object.keys(bundles).filter((l) => l !== 'en');

  for (var locale of noEnLocales) {
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${locale}!A2:C100`,
    });

    const rows = result.data.values;

    const keys = {};
    rows.forEach((row) => {
      keys[row[0]] = row[2] || '';
    });

    const str = `module.exports = ${JSON.stringify(keys, null, 2)};`;

    fs.writeFileSync(`./src/locales/${locale}.js`, str, 'utf8');
  }
}

exports.run = run;
exports.exportToGoogleSheet = exportToGoogleSheet;
exports.importFromGoogleSheet = importFromGoogleSheet;
