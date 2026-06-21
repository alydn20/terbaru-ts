import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

const SESSION_FILE = './wa-call-session.json';
const HEADLESS = true; // Set false untuk debug dengan browser visible

console.log('========================================');
console.log('🤖 WhatsApp Group Call Script');
console.log('========================================');

/**
 * Main function to call a WhatsApp group
 * @param {string} groupId - Group ID (format: 628xxxx-xxxxxx@g.us)
 */
async function callGroup(groupId) {
  if (!groupId) {
    console.error('❌ Error: Group ID tidak diberikan');
    console.log('📝 Usage: node call-group.js <groupId>');
    console.log('📝 Contoh: node call-group.js 628123456789-1234567890@g.us');
    process.exit(1);
  }

  console.log(`📞 Target: ${groupId}`);
  console.log('⏳ Launching browser...');

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: HEADLESS,
      executablePath: process.env.CHROME_BIN || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-software-rasterizer'
      ]
    }).catch(err => {
      console.error('❌ Failed to launch browser:');
      console.error(`   ${err.message}`);
      console.error('');
      console.error('💡 Chromium mungkin tidak terinstall.');
      console.error('   Run: npx puppeteer browsers install chrome');
      console.error('   Atau set CHROME_BIN environment variable');
      throw err;
    });

    console.log('✅ Browser launched');

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log('⏳ Loading WhatsApp Web...');
    await page.goto('https://web.whatsapp.com', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Load session if exists
    if (fs.existsSync(SESSION_FILE)) {
      console.log('📂 Loading saved session...');
      const sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
      await page.evaluateOnNewDocument((data) => {
        Object.keys(data).forEach(key => {
          localStorage.setItem(key, data[key]);
        });
      }, sessionData);

      await page.reload({ waitUntil: 'networkidle2' });
      console.log('✅ Session loaded');
    } else {
      console.log('⚠️  No saved session found');
      console.log('📱 Please scan QR code...');
    }

    // Wait for WhatsApp to load
    console.log('⏳ Waiting for WhatsApp to load...');

    try {
      // Wait for either QR code or chat list (means logged in)
      await Promise.race([
        page.waitForSelector('canvas[aria-label="Scan me!"]', { timeout: 10000 })
          .then(() => 'qr'),
        page.waitForSelector('[data-testid="chat-list"]', { timeout: 10000 })
          .then(() => 'logged-in')
      ]).then(async (result) => {
        if (result === 'qr') {
          console.log('📱 QR Code detected - Please scan with your phone');
          console.log('⏳ Waiting for login (60 seconds)...');

          // Wait for login
          await page.waitForSelector('[data-testid="chat-list"]', { timeout: 60000 });
          console.log('✅ Login successful!');

          // Save session
          const session = await page.evaluate(() => {
            const data = {};
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              data[key] = localStorage.getItem(key);
            }
            return data;
          });

          fs.writeFileSync(SESSION_FILE, JSON.stringify(session));
          console.log('💾 Session saved for future use');
        } else {
          console.log('✅ Already logged in');
        }
      });
    } catch (err) {
      console.error('❌ Failed to load WhatsApp:', err.message);
      throw err;
    }

    console.log('⏳ Searching for group...');

    // Search for the group
    const searchBox = await page.waitForSelector('[data-testid="chat-list-search"]', { timeout: 10000 });
    await searchBox.click();
    console.log('✅ Search box clicked');

    // Type group ID (remove @g.us for search)
    const searchText = groupId.replace('@g.us', '').replace('-', '');
    await page.keyboard.type(searchText, { delay: 100 });
    console.log(`⌨️  Typed: ${searchText}`);

    await new Promise(r => setTimeout(r, 2000));

    // Click first result
    console.log('⏳ Clicking group...');
    const chatItem = await page.waitForSelector('[data-testid="cell-frame-container"]', { timeout: 10000 });
    await chatItem.click();
    console.log('✅ Group opened');

    await new Promise(r => setTimeout(r, 2000));

    // Find and click call button
    console.log('⏳ Looking for call button...');

    // Try different selectors for call button
    const callSelectors = [
      '[data-testid="voice-call-button"]',
      '[aria-label*="Voice call"]',
      '[aria-label*="Audio call"]',
      'button[title*="Voice call"]',
      'button[title*="Audio call"]'
    ];

    let callButton = null;
    for (const selector of callSelectors) {
      try {
        callButton = await page.$(selector);
        if (callButton) {
          console.log(`✅ Call button found: ${selector}`);
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    if (!callButton) {
      console.error('❌ Call button not found');
      console.log('💡 Tip: Make sure the group supports voice calls');

      // Take screenshot for debug
      await page.screenshot({ path: 'debug-screenshot.png' });
      console.log('📸 Screenshot saved: debug-screenshot.png');

      throw new Error('Call button not found');
    }

    console.log('📞 Clicking call button...');
    await callButton.click();

    console.log('✅ Call initiated!');
    console.log('⏳ Waiting 10 seconds...');
    await new Promise(r => setTimeout(r, 10000));

    // End call
    console.log('📴 Ending call...');
    const endCallButton = await page.$('[aria-label*="End call"]');
    if (endCallButton) {
      await endCallButton.click();
      console.log('✅ Call ended');
    } else {
      console.log('⚠️  End call button not found (call may have been rejected)');
    }

    console.log('✅ Call process completed successfully!');

  } catch (error) {
    console.error('❌ Error during call process:');
    console.error(`   ${error.message}`);
    console.error('');
    console.error('Stack trace:');
    console.error(error.stack);
    process.exit(1);
  } finally {
    if (browser) {
      console.log('🔚 Closing browser...');
      await browser.close();
      console.log('✅ Browser closed');
    }
  }

  console.log('========================================');
  console.log('🎉 Script finished!');
  console.log('========================================');
}

// Get group ID from command line argument
const groupId = process.argv[2];

// Run
callGroup(groupId).catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
