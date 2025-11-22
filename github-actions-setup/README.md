# GitHub Actions Setup Guide for Price Scraping

This guide will help you set up automated price scraping using GitHub Actions with direct database access.

## 📋 What You'll Need

- GitHub account (free)
- Your Replit database URL
- OpenAI API key

## 🚀 Complete Setup Steps

### Step 1: Create GitHub Repository

1. **Go to GitHub** → https://github.com/new
2. **Repository name:** `grocery-price-scraper` (or any name)
3. **Visibility:** ✅ **Public** (for unlimited free minutes)
   - Private repos get 2,000 minutes/month
   - Public repos get **unlimited** minutes
4. **Initialize:** ✅ Check "Add a README file"
5. Click **"Create repository"**

### Step 2: Upload Files to GitHub

**IMPORTANT:** These files must be at the **root** of your repository (not in a subfolder).

#### Option A: Using GitHub Web Interface (Easiest)

1. In your new repo, click **"Add file"** → **"Upload files"**
2. Upload these files **to the root** (drag and drop from `github-actions-setup/` folder in Replit):
   - `package.json` → goes to root of repo
   - `batch-scraper.js` → goes to root of repo
3. Click **"Commit changes"**

4. Create workflow folder:
   - Click **"Add file"** → **"Create new file"**
   - Type filename: `.github/workflows/scrape-prices.yml`
   - Copy-paste the content from `github-actions-setup/.github/workflows/scrape-prices.yml`
   - Click **"Commit new file"**

**Final structure should look like:**
```
your-repo/
├── .github/
│   └── workflows/
│       └── scrape-prices.yml
├── package.json
├── batch-scraper.js
└── README.md
```

#### Option B: Using Git Command Line

```bash
# Clone your new repo
git clone https://github.com/YOUR_USERNAME/grocery-price-scraper.git
cd grocery-price-scraper

# Copy files from Replit to repo root
cp /path/to/github-actions-setup/package.json .
cp /path/to/github-actions-setup/batch-scraper.js .
mkdir -p .github/workflows
cp /path/to/github-actions-setup/.github/workflows/scrape-prices.yml .github/workflows/

# Commit and push
git add .
git commit -m "Add price scraping workflow"
git push
```

### Step 3: Get Your Database URL

From your Replit project:

```bash
# In Replit shell, run:
echo $DATABASE_URL
```

Copy the entire URL. It looks like:
```
postgresql://user:password@host.region.neon.tech/database?sslmode=require
```

### Step 4: Get Your OpenAI API Key

You already have this in Replit secrets. To copy it:

```bash
# In Replit shell:
echo $OPENAI_API_KEY
```

### Step 5: Add Secrets to GitHub

1. **Go to your repo** → **Settings** → **Secrets and variables** → **Actions**
2. Click **"New repository secret"**

**Add Secret #1:**
- Name: `DATABASE_URL`
- Value: (paste your full database URL from Step 3)
- Click **"Add secret"**

**Add Secret #2:**
- Name: `OPENAI_API_KEY`
- Value: (paste your OpenAI API key from Step 4)
- Click **"Add secret"**

### Step 6: Test the Workflow Manually

1. **Go to your repo** → **Actions** tab
2. Click **"Scrape Grocery Prices"** workflow (left sidebar)
3. Click **"Run workflow"** dropdown → **"Run workflow"** button
4. Wait for it to complete (takes 5-10 minutes)

**Check the logs:**
- Click on the running workflow
- Click on the job "scrape-and-process"
- Click on "Run price scraping" step
- You'll see live logs of scraping!

### Step 7: Verify Data in Replit

After the workflow succeeds, check your Replit database:

```sql
-- In Replit, run this SQL:
SELECT 
  ci.name,
  po.product_name,
  po.store,
  po.price_nok,
  po.price_per_kg_nok
FROM price_observations po
JOIN canonical_ingredients ci ON ci.id = po.canonical_ingredient_id
ORDER BY po.observed_at DESC
LIMIT 10;
```

You should see new observations from GitHub Actions!

## ⏰ Cron Schedule

The workflow is currently set to run **every 6 hours at :15 past the hour**:

```yaml
schedule:
  - cron: '15 */6 * * *'  # 00:15, 06:15, 12:15, 18:15 UTC
```

### Change the Schedule

Edit `.github/workflows/scrape-prices.yml`:

```yaml
# Every 12 hours
- cron: '15 */12 * * *'

# Once per day at 6 AM UTC
- cron: '0 6 * * *'

# Every 3 hours
- cron: '0 */3 * * *'

# Weekdays only at 9 AM UTC
- cron: '0 9 * * 1-5'
```

**Important:** 
- Minimum interval is 5 minutes
- Avoid `:00` times (use `:15` or `:30` instead to avoid delays)
- Times are in UTC

## 🔍 Monitoring & Debugging

### View Workflow Runs

**Actions tab** → Click any run to see:
- ✅ Success/failure status
- 📊 Processing summary
- 🐛 Error logs if failed

### Email Notifications

GitHub sends you emails when workflows fail. To customize:

**Settings** → **Notifications** → **Actions** → Configure preferences

### Debug Screenshots

If a workflow fails, screenshots are automatically saved:
- **Actions** → Failed run → **Artifacts** → Download `debug-screenshots`

### Check Database Connectivity

Add this test step to your workflow temporarily:

```yaml
- name: Test database connection
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
  run: |
    npm install pg
    node -e "const {Client}=require('pg'); new Client({connectionString:process.env.DATABASE_URL}).connect().then(()=>console.log('✓ DB OK')).catch(e=>console.error('❌',e))"
```

## 🎛️ Configuration Options

Environment variables you can set in the workflow file:

```yaml
env:
  DATABASE_URL: ${{ secrets.DATABASE_URL }}
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  BATCH_SIZE: '10'              # Process 10 ingredients per run
  CANDIDATES_PER_STORE: '5'     # Scrape 5 products per store
```

## 💰 Cost & Usage

### GitHub Actions (Public Repo)
- **Cost:** FREE
- **Minutes:** Unlimited
- **Timeout:** 6 hours per job (plenty for 10 ingredients)

### OpenAI API
- Model: gpt-4o-mini
- ~500-1000 tokens per ingredient
- ~$0.01 per 10 ingredients
- 60 ingredients/day = ~$0.06/day = **$2/month**

### Database (Neon)
- Your existing free tier includes this
- No additional costs

## 🚨 Troubleshooting

### "No ingredients processed"

**Cause:** All ingredients already have observations

**Solution:** Either:
1. Delete old observations to reprocess:
   ```sql
   DELETE FROM price_observations;
   ```
2. Add new ingredients to `canonical_ingredients` table

### "OpenAI API error 401"

**Cause:** Invalid API key

**Fix:**
1. Verify your OpenAI API key is correct
2. Update GitHub secret: **Settings** → **Secrets** → Edit `OPENAI_API_KEY`

### "Database connection failed"

**Cause:** Invalid DATABASE_URL

**Fix:**
1. Verify your database URL is correct
2. Check it includes `?sslmode=require` at the end
3. Update GitHub secret: **Settings** → **Secrets** → Edit `DATABASE_URL`

### "Scraping failed"

**Cause:** Oda or Meny website changed

**Fix:**
1. Check workflow logs for specific error
2. Website structure may have changed
3. Update selectors in `batch-scraper.js`

### Workflow not running on schedule

**Causes:**
- Schedule only triggers from **main/default branch**
- GitHub may delay schedules during high load
- Repository might be dormant (no activity for 60 days)

**Fix:**
- Ensure workflow file is in main branch
- Make a commit to wake up the repo
- Use manual trigger: **Actions** → **Run workflow**

## 📊 Expected Performance

Per batch (10 ingredients):
- **Time:** 5-10 minutes
- **Success rate:** 80-90% (depends on product availability)
- **Database growth:** ~100 new rows (candidates + observations)

## 🔄 How It Works

```
GitHub Actions (every 6 hours)
    ↓
1. Read unprocessed ingredients from canonical_ingredients table
    ↓
2. Launch Puppeteer browser
    ↓
3. Scrape Oda.com for each ingredient
    ↓
4. Scrape Meny.no for each ingredient
    ↓
5. Save all candidates to price_observation_candidates table
    ↓
6. Call OpenAI API to select best representative product
    ↓
7. Save selected product to price_observations table
    ↓
8. Close browser, disconnect from database
    ↓
✅ Done! Next run in 6 hours.
```

## 🎯 Next Steps

1. ✅ Verify first manual run succeeds
2. ✅ Check data appears in Replit database
3. ✅ Wait for first scheduled run (6 hours)
4. 📊 Monitor in GitHub Actions tab
5. 🎨 Build admin dashboard to visualize data!

## 📝 Notes

- **No need to publish your Replit app** - GitHub Actions connects directly to database
- **Scraping runs independently** - Your Replit app can be offline
- **Secrets are secure** - GitHub encrypts all repository secrets
- **Completely serverless** - No infrastructure to manage

## ✨ Success Indicators

You'll know it's working when:
- ✅ GitHub Actions shows green checkmarks
- ✅ `price_observations` table grows every 6 hours
- ✅ `canonical_ingredients` with no observations decreases
- ✅ No error emails from GitHub

---

**Questions?** Check the workflow logs in GitHub Actions → Your workflow run → Job details
