const puppeteer = require('puppeteer');
const { Client } = require('pg');
const cheerio = require('cheerio');

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '10');
const CANDIDATES_PER_STORE = parseInt(process.env.CANDIDATES_PER_STORE || '5');

// Database helper
class Database {
  constructor() {
    this.client = new Client({ connectionString: process.env.DATABASE_URL });
  }

  async connect() {
    await this.client.connect();
  }

  async getUnprocessedIngredients(limit) {
    const result = await this.client.query(`
      SELECT ci.id, ci.name
      FROM canonical_ingredients ci
      LEFT JOIN price_observations po ON ci.id = po.canonical_ingredient_id
      WHERE po.id IS NULL
      ORDER BY ci.created_at ASC
      LIMIT $1
    `, [limit]);
    return result.rows;
  }

  async saveCandidates(candidates) {
    if (candidates.length === 0) return [];
    
    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    candidates.forEach((c, i) => {
      placeholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7})`);
      values.push(
        c.canonicalIngredientId,
        c.store,
        c.productName,
        c.productUrl || null,
        c.packageSizeValue || null,
        c.packageSizeUnit || null,
        c.priceNok,
        c.pricePerKgNok || null
      );
      paramIndex += 8;
    });

    const query = `
      INSERT INTO price_observation_candidates 
      (canonical_ingredient_id, store, product_name, product_url, package_size_value, package_size_unit, price_nok, price_per_kg_nok)
      VALUES ${placeholders.join(', ')}
      RETURNING id
    `;

    const result = await this.client.query(query, values);
    return result.rows;
  }

  async saveObservation(observation) {
    const result = await this.client.query(`
      INSERT INTO price_observations 
      (canonical_ingredient_id, selected_candidate_id, store, product_name, product_url, 
       package_size_value, package_size_unit, price_nok, price_per_kg_nok, source_version)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `, [
      observation.canonicalIngredientId,
      observation.selectedCandidateId,
      observation.store,
      observation.productName,
      observation.productUrl || null,
      observation.packageSizeValue || null,
      observation.packageSizeUnit || null,
      observation.priceNok,
      observation.pricePerKgNok || null,
      observation.sourceVersion
    ]);
    return result.rows[0];
  }

  async close() {
    await this.client.end();
  }
}

// Scraper helper
async function scrapeOdaProducts(browser, query, limit) {
  const page = await browser.newPage();
  const products = [];
  const networkRequests = [];

  try {
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Listen for API responses (network interception)
    page.on('response', async (response) => {
      const url = response.url();
      const method = response.request().method();
      
      if (url.includes('oda.com') && url.includes('/api/') && url.includes('product')) {
        try {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.includes('application/json')) {
            const data = await response.json();
            networkRequests.push({ url, method, response: data });
          }
        } catch (error) {
          // Ignore JSON parsing errors
        }
      }
    });
    
    const searchUrl = `https://oda.com/no/search/products/?q=${encodeURIComponent(query)}`;
    console.log(`Navigating to: ${searchUrl}`);
    
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Debug: Check page content
    const pageTitle = await page.title();
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200));
    console.log(`Page title: ${pageTitle}`);
    console.log(`Page preview: ${bodyText.substring(0, 100)}...`);

    // Try network interception first
    if (networkRequests.length > 0) {
      console.log(`Found ${networkRequests.length} API requests`);
      const apiProducts = extractProductsFromApiResponses(networkRequests);
      if (apiProducts.length > 0) {
        console.log(`Extracted ${apiProducts.length} products from API responses`);
        products.push(...apiProducts.slice(0, limit));
        return products;
      }
    }

    // Fall back to DOM evaluation (using EXACT working code)
    console.log('Falling back to DOM evaluation');
    
    const extractedProducts = await page.evaluate(() => {
      const productTiles = Array.from(document.querySelectorAll('[data-testid="product-tile"]')).slice(0, 10);
      const results = [];

      for (const tile of productTiles) {
        try {
          const ariaLabel = tile.getAttribute('aria-label') || '';
          if (!ariaLabel) continue;
          
          const parts = ariaLabel.split(' - ');
          const title = parts[0]?.trim();
          if (!title) continue;
          
          // Enhanced weight extraction to handle multi-packs (2×75g, 3x100g, 2pk, etc.)
          let weight;
          
          const multiPackMatch = ariaLabel.match(/(\d+)\s*[x×]\s*(\d+[.,]?\d*)\s*(g|kg|l|ml)\b/i) ||
                                 ariaLabel.match(/(\d+)\s*pk\s*[aà]?\s*(\d+[.,]?\d*)\s*(g|kg|l|ml)\b/i);
          
          if (multiPackMatch) {
            const multiplier = parseInt(multiPackMatch[1]);
            const baseValue = parseFloat(multiPackMatch[2].replace(',', '.'));
            const unit = multiPackMatch[3];
            const totalValue = multiplier * baseValue;
            weight = `${totalValue} ${unit}`;
          } else {
            const weightMatch = ariaLabel.match(/(\d+[.,]?\d*)\s*(l|kg|g|ml|stk)/i);
            weight = weightMatch ? weightMatch[0] : undefined;
          }
          
          const allText = (tile.textContent || '').replace(/\u00A0/g, ' ');
          
          const priceMatch = allText.match(/kr\s*(\d+[.,]\d+)|(\d+[.,]\d+)\s*kr/);
          const priceStr = priceMatch ? (priceMatch[1] || priceMatch[2]).replace(',', '.') : null;
          const price = priceStr ? parseFloat(priceStr) : 0;
          if (price <= 0) continue;
          
          const unitPriceMatch = allText.match(/(\d+[.,]\d+)\s*kr?\s*\/\s*([lkgml]+)/i);
          const unitPrice = unitPriceMatch ? `${unitPriceMatch[1]} kr/${unitPriceMatch[2]}` : undefined;
          
          const imgEl = tile.querySelector('img');
          const imageUrl = imgEl?.getAttribute('src');
          
          const linkEl = tile.querySelector('a[href*="/products/"]');
          const href = linkEl?.getAttribute('href') || '';
          const productIdMatch = href.match(/\/products\/(\d+)-/);
          const productId = productIdMatch ? productIdMatch[1] : `product-${results.length}`;
          
          results.push({
            id: productId,
            title,
            brand: undefined,
            price,
            unit_price: unitPrice,
            weight,
            image_url: imageUrl || undefined,
            badges: [],
          });
        } catch (error) {
          // Skip products with errors
        }
      }

      return results;
    });

    products.push(...extractedProducts.slice(0, limit));
  } catch (error) {
    console.error('Error scraping Oda:', error);
  } finally {
    await page.close();
  }

  return products;
}

async function scrapeMenyProducts(browser, query, limit) {
  const page = await browser.newPage();
  const products = [];

  try {
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    const searchUrl = `https://meny.no/sok/?query=${encodeURIComponent(query)}&expanded=products`;
    console.log(`Searching Meny for: ${query}`);
    console.log(`Navigating to: ${searchUrl}`);
    
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Use EXACT working Meny scraper code
    const extractedProducts = await page.evaluate(() => {
      const productLinks = Array.from(document.querySelectorAll('a[href*="/varer/"]'));
      const results = [];
      const seen = new Set();

      for (const link of productLinks) {
        try {
          const href = link.getAttribute('href') || '';
          if (!href || seen.has(href)) continue;
          
          const container = link.closest('article, li, div') || link.parentElement;
          if (!container) continue;
          
          const allText = container.textContent || '';
          if (allText.length < 20) continue;
          
          const h3Element = container.querySelector('h3');
          const title = h3Element?.textContent?.trim();
          if (!title || title.length < 3) continue;
          
          const priceText = allText.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ');
          const priceMatch = priceText.match(/(\d+[.,]\d+)\s*kr(?!\/)/) || priceText.match(/kr\s*(\d+[.,]\d+)/);
          if (!priceMatch) continue;
          
          const priceStr = (priceMatch[1] || priceMatch[2] || '0').replace(',', '.');
          const price = parseFloat(priceStr);
          if (price <= 0) continue;
          
          const unitPriceMatch = priceText.match(/(\d+[.,]\d+)\s*kr\s*\/\s*(kg|l|stk)/i);
          const unitPrice = unitPriceMatch ? `${unitPriceMatch[1]} kr/${unitPriceMatch[2]}` : undefined;
          
          // Enhanced weight extraction to handle multi-packs (2×75g, 3x100g, 2pk, etc.)
          let weight;
          
          const multiPackMatch = allText.match(/(\d+)\s*[x×]\s*(\d+[.,]?\d*)\s*(g|kg|l|ml)\b/i) ||
                                 allText.match(/(\d+)\s*pk\s*[aà]?\s*(\d+[.,]?\d*)\s*(g|kg|l|ml)\b/i);
          
          if (multiPackMatch) {
            const multiplier = parseInt(multiPackMatch[1]);
            const baseValue = parseFloat(multiPackMatch[2].replace(',', '.'));
            const unit = multiPackMatch[3];
            const totalValue = multiplier * baseValue;
            weight = `${totalValue} ${unit}`;
          } else {
            const weightMatch = allText.match(/(\d+[.,]?\d*)\s*(g|kg|l|ml|stk)\b/i);
            weight = weightMatch ? weightMatch[0] : undefined;
          }
          
          const imgEl = container.querySelector('img');
          const imageUrl = imgEl?.getAttribute('src');
          
          const productIdMatch = href.match(/\/varer\/[^\/]+\/[^\/]+\/[^\/]+\/([^\/]+)/);
          const productId = productIdMatch ? productIdMatch[1] : href.split('/').pop() || `meny-${results.length}`;
          
          seen.add(href);
          results.push({
            id: productId,
            title,
            brand: undefined,
            price,
            unit_price: unitPrice,
            weight,
            image_url: imageUrl || undefined,
            badges: [],
          });
          
          if (results.length >= 10) break;
        } catch (error) {
          // Skip products with errors
        }
      }

      return results;
    });

    products.push(...extractedProducts.slice(0, limit));
  } catch (error) {
    console.error('Error scraping Meny:', error);
  } finally {
    await page.close();
  }

  return products;
}

// AI Evaluator
async function evaluateWithAI(ingredientName, candidates) {
  const candidatesList = candidates
    .map((c, i) => {
      const pricePerKg = c.pricePerKgNok ? `${c.pricePerKgNok.toFixed(2)} NOK/kg` : 'N/A';
      const store = c.store ? `[${c.store.toUpperCase()}]` : '';
      return `${i + 1}. ${store} "${c.productName}" - ${c.priceNok} NOK (${pricePerKg})`;
    })
    .join('\n');

  const prompt = `You are selecting the BEST MATCHING product for the ingredient "${ingredientName}" for accurate recipe price estimation.

Product candidates from Oda and Meny stores:
${candidatesList}

SELECTION CRITERIA (in priority order):
1. **Ingredient match** - Prefer exact match, but close alternatives are OK for rare ingredients
   - Example: If searching "reinsdyr ytrefilet" (reindeer tenderloin) but only "reinsdyr indrefilet" (reindeer sirloin) exists, that's acceptable
   - NEVER substitute different animals (e.g., lamb for reindeer)
2. **Raw ingredient** - NOT heavily processed or mixed products
3. **Standard package** - Typical consumer sizes
4. **Representative quality** - Select typical consumer choice for realistic price estimates
   - Avoid extreme outliers (both cheapest and most expensive options)
   - Choose products that represent common consumer purchases
   - Consider typical quality expectations for the ingredient type
   - NOT always the lowest price, but realistic everyday choice

IMPORTANT: Price estimation should reflect REALISTIC shopping behavior, not bargain hunting or luxury purchases.

If NO exact match exists:
- Select the CLOSEST alternative from the same ingredient category
- In reasoning, note: "Close match: [explain what's different]"

If products are WRONG ingredient entirely:
- Do NOT select any product
- Return empty selectedIndices: []
- In reasoning, explain: "No valid matches found"

Return JSON:
{
  "selectedIndices": [single number 1-${candidates.length} OR empty array []],
  "reasoning": "Explain match quality and selection criteria"
}`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You evaluate grocery products to find the best match for ingredient queries. Return only valid JSON.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content;
  const parsed = JSON.parse(content);
  
  if (data.usage) {
    console.log('💰 AI Token usage:', {
      prompt: data.usage.prompt_tokens,
      completion: data.usage.completion_tokens,
      total: data.usage.total_tokens
    });
  }

  return {
    selectedIndices: (parsed.selectedIndices || []).map(idx => idx - 1),
    reasoning: parsed.reasoning || 'AI selected product'
  };
}

// Extract products from API network responses
function extractProductsFromApiResponses(requests) {
  const products = [];
  
  for (const req of requests) {
    if (!req.response) continue;
    
    const data = req.response;
    
    if (data.products && Array.isArray(data.products)) {
      for (const item of data.products) {
        const product = parseProductFromApi(item);
        if (product) products.push(product);
      }
    } else if (data.data?.products && Array.isArray(data.data.products)) {
      for (const item of data.data.products) {
        const product = parseProductFromApi(item);
        if (product) products.push(product);
      }
    } else if (data.results && Array.isArray(data.results)) {
      for (const item of data.results) {
        const product = parseProductFromApi(item);
        if (product) products.push(product);
      }
    } else if (Array.isArray(data)) {
      for (const item of data) {
        if (item.id || item.name || item.title) {
          const product = parseProductFromApi(item);
          if (product) products.push(product);
        }
      }
    }
  }
  
  return products;
}

// Parse individual product from API response
function parseProductFromApi(item) {
  const id = item.id || item.product_id || item.sku || item.code;
  const title = item.name || item.title || item.product_name;
  const brand = item.brand || item.manufacturer || item.vendor;
  
  if (!title) {
    return null;
  }
  
  const priceValue = item.price ?? item.gross_price ?? item.sale_price ?? item.current_price;
  const parsedPrice = typeof priceValue === 'number' ? priceValue : parseFloat(String(priceValue || 0));
  
  if (isNaN(parsedPrice) || parsedPrice <= 0) {
    return null;
  }
  
  const slugTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const weight = item.weight || item.size || item.volume || item.net_weight;
  const deterministic = `${brand || 'unknown'}-${slugTitle}-${weight || 'std'}`.slice(0, 100);
  
  const fallbackId = id || deterministic;
  
  return {
    id: String(fallbackId),
    title: title,
    brand: brand || undefined,
    price: parsedPrice,
    unit_price: item.unit_price || item.price_per_unit || item.comparison_price || undefined,
    weight: weight || undefined,
    image_url: item.image_url || item.image || item.thumbnail || item.images?.[0]?.url || undefined,
    badges: Array.isArray(item.badges) ? item.badges : Array.isArray(item.labels) ? item.labels : Array.isArray(item.tags) ? item.tags : [],
  };
}

// Helper functions
function extractPricePerKg(unitPriceStr) {
  if (!unitPriceStr) return null;
  const match = unitPriceStr.match(/(\d+[.,]?\d*)\s*kr\s*\/\s*kg/i);
  if (match) {
    return parseFloat(match[1].replace(',', '.'));
  }
  return null;
}

function calculatePricePerKg(price, weightStr) {
  if (!weightStr) return null;
  
  const weightMatch = weightStr.match(/(\d+[.,]?\d*)\s*(g|kg|ml|l)/i);
  if (!weightMatch) return null;
  
  const value = parseFloat(weightMatch[1].replace(',', '.'));
  const unit = weightMatch[2].toLowerCase();
  
  let grams = 0;
  if (unit === 'kg') grams = value * 1000;
  else if (unit === 'g') grams = value;
  else if (unit === 'l') grams = value * 1000;
  else if (unit === 'ml') grams = value;
  
  if (grams > 0) {
    return (price / grams) * 1000;
  }
  return null;
}

function productToCandidate(product, ingredientId, store) {
  let pricePerKg = extractPricePerKg(product.unit_price);
  let calculatedPricePerKg = null;
  
  if (pricePerKg === null && product.weight) {
    calculatedPricePerKg = calculatePricePerKg(product.price, product.weight);
    pricePerKg = calculatedPricePerKg;
    if (pricePerKg !== null) {
      console.log(`  ✓ Calculated price/kg: ${pricePerKg.toFixed(2)} NOK/kg from ${product.price} NOK / ${product.weight}`);
    }
  } else if (pricePerKg !== null && product.weight) {
    // Validate: calculate price/kg and compare with store-provided value
    calculatedPricePerKg = calculatePricePerKg(product.price, product.weight);
    if (calculatedPricePerKg !== null) {
      const percentDiff = Math.abs((calculatedPricePerKg - pricePerKg) / pricePerKg) * 100;
      if (percentDiff > 10) {
        console.warn(`⚠️  PRICE MISMATCH for "${product.title}":`);
        console.warn(`    Store says: ${pricePerKg.toFixed(2)} NOK/kg`);
        console.warn(`    Calculated: ${calculatedPricePerKg.toFixed(2)} NOK/kg from ${product.price} NOK / ${product.weight}`);
        console.warn(`    Difference: ${percentDiff.toFixed(1)}% (${percentDiff > 50 ? 'LIKELY MULTI-PACK!' : 'check packaging'})`);
      }
    }
  }

  return {
    canonicalIngredientId: ingredientId,
    store: store,
    productName: product.title,
    productUrl: product.id,
    packageSizeValue: null,
    packageSizeUnit: product.weight || null,
    priceNok: product.price.toString(),
    pricePerKgNok: pricePerKg ? pricePerKg.toString() : null
  };
}

// Product filtering (same logic as TypeScript version)
function filterRelevantProducts(products, ingredientName) {
  const keywords = ingredientName
    .toLowerCase()
    .split(/\s+/)
    .filter(word => word.length > 2);
  
  if (keywords.length === 0 || products.length === 0) {
    return products;
  }
  
  const stemKeyword = (word) => {
    if (word.includes('reinsdyr') || word.includes('rein')) return 'rein';
    if (word.includes('lam') || word === 'lamb') return 'lam';
    if (word.includes('storfe') || word.includes('okse')) return 'storfe';
    if (word.includes('svin') || word.includes('pork')) return 'svin';
    if (word.includes('kylling') || word.includes('chicken')) return 'kylling';
    return word;
  };
  
  const stemmedIngredientKeywords = keywords.map(stemKeyword);
  const primaryStem = stemmedIngredientKeywords[0];
  
  const conflictingStems = new Map([
    ['rein', ['lam', 'storfe', 'svin', 'kylling']],
    ['lam', ['rein', 'storfe', 'svin', 'kylling']],
    ['storfe', ['rein', 'lam', 'svin', 'kylling']],
    ['svin', ['rein', 'lam', 'storfe', 'kylling']],
    ['kylling', ['rein', 'lam', 'storfe', 'svin']],
  ]);
  
  const filtered = products.filter(product => {
    const productTitle = product.title.toLowerCase();
    const productWords = productTitle.split(/\s+/);
    const stemmedProductWords = productWords.map(stemKeyword);
    
    if (conflictingStems.has(primaryStem)) {
      const conflicts = conflictingStems.get(primaryStem);
      for (const conflict of conflicts) {
        if (stemmedProductWords.includes(conflict)) {
          console.log(`⚠️  Rejected "${product.title}" - wrong species "${conflict}" (expected "${primaryStem}")`);
          return false;
        }
      }
    }
    
    console.log(`✓ Accepted "${product.title}"`);
    return true;
  });
  
  if (filtered.length === 0) {
    console.log(`⚠️  WARNING: All products filtered out for "${ingredientName}". Keeping original results for AI to evaluate.`);
    return products;
  }
  
  return filtered;
}

// Main processing logic
async function processIngredient(browser, db, ingredient) {
  console.log(`\n=== Processing ingredient: ${ingredient.name} ===`);
  
  try {
    // Scrape Oda
    const odaProductsRaw = await scrapeOdaProducts(browser, ingredient.name, CANDIDATES_PER_STORE);
    console.log(`Found ${odaProductsRaw.length} raw products on Oda`);
    const odaProducts = filterRelevantProducts(odaProductsRaw, ingredient.name);
    console.log(`Filtered to ${odaProducts.length} relevant Oda products`);
    
    // Scrape Meny
    const menyProductsRaw = await scrapeMenyProducts(browser, ingredient.name, CANDIDATES_PER_STORE);
    console.log(`Found ${menyProductsRaw.length} raw products on Meny`);
    const menyProducts = filterRelevantProducts(menyProductsRaw, ingredient.name);
    console.log(`Filtered to ${menyProducts.length} relevant Meny products`);
    
    if (odaProducts.length === 0 && menyProducts.length === 0) {
      console.log('❌ No relevant products found on any store after filtering');
      return { success: false, error: 'No relevant products found' };
    }
    
    // Convert to candidates
    const odaCandidates = odaProducts.map(p => productToCandidate(p, ingredient.id, 'oda'));
    const menyCandidates = menyProducts.map(p => productToCandidate(p, ingredient.id, 'meny'));
    
    // Save candidates to database
    const savedOda = await db.saveCandidates(odaCandidates);
    const savedMeny = await db.saveCandidates(menyCandidates);
    console.log(`Saved ${savedOda.length + savedMeny.length} candidates to database`);
    
    // Prepare for AI evaluation
    const allCandidatesForAI = [
      ...odaProducts.map(p => {
        let pricePerKg = extractPricePerKg(p.unit_price);
        if (!pricePerKg && p.weight) {
          pricePerKg = calculatePricePerKg(p.price, p.weight);
        }
        return {
          productName: p.title,
          priceNok: p.price,
          pricePerKgNok: pricePerKg,
          store: 'oda'
        };
      }),
      ...menyProducts.map(p => {
        let pricePerKg = extractPricePerKg(p.unit_price);
        if (!pricePerKg && p.weight) {
          pricePerKg = calculatePricePerKg(p.price, p.weight);
        }
        return {
          productName: p.title,
          priceNok: p.price,
          pricePerKgNok: pricePerKg,
          store: 'meny'
        };
      })
    ];
    
    // AI evaluation
    console.log('\n--- AI Evaluation ---');
    const evaluation = await evaluateWithAI(ingredient.name, allCandidatesForAI);
    
    if (!evaluation || evaluation.selectedIndices.length === 0) {
      console.log('❌ AI found no valid matches');
      return { success: false, error: 'AI found no matches' };
    }
    
    // Get selected product
    const selectedIdx = evaluation.selectedIndices[0];
    const allProducts = [...odaProducts, ...menyProducts];
    const allSavedIds = [...savedOda, ...savedMeny];
    const selectedProduct = allProducts[selectedIdx];
    const selectedCandidateId = allSavedIds[selectedIdx].id;
    const selectedStore = selectedIdx < odaProducts.length ? 'oda' : 'meny';
    
    console.log(`✓ AI selected: ${selectedProduct.title} from ${selectedStore}`);
    console.log(`  Reasoning: ${evaluation.reasoning}`);
    
    // Calculate final price per kg
    let finalPricePerKg = extractPricePerKg(selectedProduct.unit_price);
    if (!finalPricePerKg && selectedProduct.weight) {
      finalPricePerKg = calculatePricePerKg(selectedProduct.price, selectedProduct.weight);
    }
    
    // Save observation
    const observation = {
      canonicalIngredientId: ingredient.id,
      selectedCandidateId: selectedCandidateId,
      store: selectedStore,
      productName: selectedProduct.title,
      productUrl: selectedProduct.id,
      packageSizeValue: null,
      packageSizeUnit: selectedProduct.weight || null,
      priceNok: selectedProduct.price.toString(),
      pricePerKgNok: finalPricePerKg ? finalPricePerKg.toString() : null,
      sourceVersion: `scraper_v2: ${evaluation.reasoning}`
    };
    
    await db.saveObservation(observation);
    console.log('✓ Saved observation to database');
    console.log(`=== Completed: ${ingredient.name} ===\n`);
    
    return { success: true };
  } catch (error) {
    console.error(`Error processing ${ingredient.name}:`, error);
    return { success: false, error: error.message };
  }
}

// Main function
async function main() {
  console.log('\n=== GitHub Actions Batch Processing Started ===');
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log(`Candidates per store: ${CANDIDATES_PER_STORE}`);
  console.log(`Time: ${new Date().toISOString()}\n`);
  
  const db = new Database();
  let browser = null;
  
  try {
    await db.connect();
    console.log('✓ Connected to database');
    
    const ingredients = await db.getUnprocessedIngredients(BATCH_SIZE);
    
    if (ingredients.length === 0) {
      console.log('✓ No unprocessed ingredients found. All done!');
      process.exit(0);
    }
    
    console.log(`Found ${ingredients.length} unprocessed ingredients\n`);
    
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    
    console.log('✓ Browser launched');
    
    const results = [];
    for (const ingredient of ingredients) {
      const result = await processIngredient(browser, db, ingredient);
      results.push(result);
    }
    
    const summary = {
      total: results.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length
    };
    
    console.log('\n=== Batch Processing Summary ===');
    console.log(`Total processed: ${summary.total}`);
    console.log(`✓ Successful: ${summary.successful}`);
    console.log(`✗ Failed: ${summary.failed}`);
    console.log(`Completed at: ${new Date().toISOString()}\n`);
    
    process.exit(summary.failed > 0 ? 1 : 0);
  } catch (error) {
    console.error('\n❌ Batch processing failed:', error);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
    await db.close();
  }
}

main();
