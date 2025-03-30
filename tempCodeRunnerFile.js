const puppeteer = require('puppeteer');
const fs = require('fs');
const axios = require('axios');

const CONFIG = {
  groqApiKey: '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',
  maxClicks: 7,
  apiDelay: 60000,
  nsePattern: /^NSE:[A-Z0-9]{2,10}$/i,
  wpApiUrl: 'https://profitbooking.in/wp-json/scraper/v1/angelone_news'
};

async function scrapeAngelNews() {
  console.log('Launching browser...');
 const browser = await puppeteer.launch({ 
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });  const page = await browser.newPage();
  
  console.log('Navigating to Angel One news page...');
  await page.goto('https://www.angelone.in/news', { waitUntil: 'networkidle2' });

  // Pagination handling
  console.log('Starting pagination handling...');
  for (let i = 0; i < CONFIG.maxClicks; i++) {
    try {
      console.log(`Attempting to click LOAD MORE button, iteration ${i + 1}...`);
      const loadMoreButton = await page.waitForSelector('a.SfOz_M', { timeout: 5000 });
      await loadMoreButton.click();
      await page.waitForNetworkIdle();
      console.log(`Clicked LOAD MORE ${i + 1} times`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.log('No more LOAD MORE buttons to click or an error occurred.');
      break;
    }
  }

  // Article collection
  console.log('Collecting articles...');
  const articles = await page.$$eval('div.erblPH', (elements) => 
    elements.map(el => ({
      title: el.querySelector('h4')?.innerText?.trim(),
      link: el.querySelector('a')?.href,
      date: el.querySelector('span')?.innerText?.split('•')[0]?.trim()
    })).filter(a => a.title)
  );
  console.log(`Collected ${articles.length} articles.`);

  // Process articles with enhanced validation
  let lastApiCall = 0;
  for (const [index, article] of articles.entries()) {
    console.log(`Processing article ${index + 1}: ${article.title}`);
    try {
      // Rate limiting
      const now = Date.now();
      if (now - lastApiCall < CONFIG.apiDelay) {
        const delay = CONFIG.apiDelay - (now - lastApiCall);
        console.log(`Rate limiting in effect. Waiting for ${delay} ms before next API call.`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      const groqResponse = await queryGroq(article.title);
      lastApiCall = Date.now();

      if (isValidNseResponse(groqResponse)) {
        console.log(`Valid NSE response received for article: ${article.title}`);
        const conclusion = await scrapeConclusion(browser, article.link);
        
        await storeInWordPress({
          headline: article.title,
          conclusion: conclusion,
          company: groqResponse.company_name,
          nsc: groqResponse.nsc,
          confidence: groqResponse.confidence,
          news_date: groqResponse.news_date
        });
        console.log(`Article ${index + 1} processed and stored in WordPress.`);
      } else {
        console.log(`Invalid NSE response for article: ${article.title}`);
      }
    } catch (error) {
      console.error(`Error processing article ${index + 1}:`, error.message);
    }
  }

  console.log('Closing browser...');
  await browser.close();
}

// Improved Groq query with strict JSON formatting
async function queryGroq(text) {
  console.log(`Querying Groq API for text: ${text.substring(0, 50)}...`);
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'deepseek-r1-distill-llama-70b',
        messages: [{
          role: "user",
          content: `Analyze this news headline for NSE-listed companies. Respond ONLY with valid JSON:
          {
            "company_name": "string|null",
            "nsc": "string|null (format: NSE:SYMBOL)",
            "confidence": "number|null (0-1)",
            "news_date": "string|null (YYYY-MM-DD)"
          }
          Example valid response for NSE company: 
          {"company_name": "Reliance Industries", "nsc": "NSE:RELIANCE", "confidence": 0.92, "news_date": "2024-03-28"}
          Example null response: 
          {"company_name": null, "nsc": null, "confidence": null, "news_date": null}
          Headline: ${text.substring(0, 1000)}`
        }],
        temperature: 0.1,
        response_format: { type: "json_object" }
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.groqApiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );

    console.log('Groq API response received.');
    return validateGroqResponse(response);
  } catch (error) {
    console.error('Groq API error:', error.response?.data?.error?.code || error.code);
    return null;
  }
}

function validateGroqResponse(response) {
  console.log('Validating Groq API response...');
  try {
    const data = JSON.parse(response.data.choices[0].message.content);
    console.log('Groq API response validated successfully.');
    return {
      company_name: data.company_name || null,
      nsc: data.nsc ? data.nsc.toUpperCase() : null,
      confidence: Number(data.confidence) || 0,
      news_date: data.news_date || null
    };
  } catch (error) {
    console.error('Invalid JSON response from Groq');
    return null;
  }
}

function isValidNseResponse(response) {
  console.log('Checking if response is a valid NSE response...');
  const isValid = response?.nsc && 
                  CONFIG.nsePattern.test(response.nsc) && 
                  response.confidence > 0.8;
  console.log(`NSE response validity: ${isValid}`);
  return isValid;
}

async function scrapeConclusion(browser, url) {
    console.log(`Scraping conclusion from URL: ${url}`);
    const page = await browser.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

        // Find dynamic conclusion ID using CSS attribute selector
        const conclusionSelector = '[id^="conclusion-"]';
        await page.waitForSelector(conclusionSelector, { timeout: 5000 });

        // Get the actual conclusion ID
        const conclusionId = await page.$eval(conclusionSelector, el => el.id);
        const paragraphSelector = `#${conclusionId} + p`;

        const conclusion = await page.$eval(paragraphSelector, 
            el => el.innerText.trim()
        );

        console.log('Conclusion scraped successfully.');
        return conclusion;
    } catch (error) {
        console.error('Error scraping conclusion:', error.message);
        // Fallback method if conclusion section not found
        try {
            return await page.$eval('.article-content p:last-of-type', 
                el => el.innerText.trim()
            );
        } catch (fallbackError) {
            console.error('Fallback scraping failed:', fallbackError.message);
            return 'Conclusion not available';
        }
    } finally {
        await page.close();
    }
}


async function storeInWordPress(data) {
  try {
    const response = await axios.post(CONFIG.wpApiUrl, {
      title: data.headline,
      content: data.conclusion,
      company: data.company,
      nsc: data.nsc,
      confidence: data.confidence,
      news_date: data.news_date
    });

    console.log('Stored in WordPress:', response.data);
    return true;
  } catch (error) {
    console.error('WP API Error:', error.response?.data || error.message);
    return false;
  }
}

// Rest of the functions remain same as previous version...

scrapeAngelNews().catch(console.error);
