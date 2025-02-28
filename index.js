require('dotenv').config(); // No path, Render uses env vars
const axios = require('axios');
const cheerio = require('cheerio');
const { TwitterApi } = require('twitter-api-v2');
const TelegramBot = require('node-telegram-bot-api');
const natural = require('natural');

// Configuration
const CONFIG = {
  twitter: {
    bearer_token: process.env.TWITTER_BEARER_TOKEN
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
  },
  dexScreenerApi: 'https://api.dexscreener.com/latest/dex/tokens/',
  influencerThreshold: 5000,
  listingAccount: 'MEXC_Listings',
  filters: {
    minLiquidity: 100000,
    minVolume: 1000000,
    minFDV: 2000000,
    minInfluencers: 2,
    minMentions: 50
  }
};

// Validate Twitter config
if (!CONFIG.twitter.bearer_token) {
  throw new Error('Twitter Bearer Token is missing in CONFIG');
}

// Initialize APIs
const twitterClient = new TwitterApi(CONFIG.twitter.bearer_token);
const telegramBot = new TelegramBot(CONFIG.telegram.token, { polling: false });

// Axios with browser-like User-Agent
const axiosInstance = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  }
});

// Store processed tokens
const processedTokens = new Set();

// Fetch new listings from X using v2
async function fetchNewListings() {
  try {
    const response = await twitterClient.v2.search({
      query: 'from:MEXC_Listings "MEXC Will List" OR "New listing on #MEXC" OR "will be listed on #MEXC"',
      max_results: 20,
      'tweet.fields': ['created_at', 'text'],
      expansions: 'attachments.media_keys'
    });

    const rateLimit = response.rateLimit;
    console.log(`Rate Limit Info (Listings): ${rateLimit.remaining}/${rateLimit.limit}, Reset at ${new Date(rateLimit.reset * 1000)}`);

    const listings = [];
    const now = Date.now();
    const tweets = response.data.data || [];

    for (const tweet of tweets) {
      const text = tweet.text;
      const createdAt = new Date(tweet.created_at).getTime();
      if (now - createdAt > 2 * 60 * 60 * 1000) continue;

      const tokenMatch = text.match(/\$([A-Z]{2,10})/);
      const token = tokenMatch ? tokenMatch[1] : null;
      if (token && !processedTokens.has(token)) {
        const linkMatch = text.match(/(https?:\/\/[^\s]+)/);
        listings.push({
          token,
          title: text.split('\n')[0],
          link: linkMatch ? linkMatch[0] : `https://twitter.com/${CONFIG.listingAccount}/status/${tweet.id}`,
          date: tweet.created_at
        });
      }
    }

    return listings;
  } catch (error) {
    if (error.code === 429) {
      const resetTime = error.rateLimit.reset * 1000;
      const waitTime = resetTime - Date.now();
      console.log(`Rate limit hit (Listings). Waiting ${Math.ceil(waitTime / 60000)} minutes until ${new Date(resetTime)}`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return await fetchNewListings();
    }
    console.error('Error fetching X listings:', error);
    return [];
  }
}

// Basic fundamental analysis
async function fetchFundamentals(listing) {
  try {
    const response = await axiosInstance.get(listing.link);
    const $ = cheerio.load(response.data);
    const team = $('body').text().toLowerCase().includes('team') ? 'Mentioned' : 'Not found';
    const useCase = $('body').text().length > 500 ? 'Detailed' : 'Vague';
    return { team, useCase };
  } catch (error) {
    console.error(`Error fetching fundamentals for ${listing.token}:`, error.response?.status || error.message);
    return { team: 'N/A', useCase: 'N/A' };
  }
}

// Fetch token data from DexScreener
async function fetchTokenData(token) {
  try {
    const response = await axios.get(`${CONFIG.dexScreenerApi}${token}`);
    const pair = response.data.pairs?.[0];
    if (!pair) return null;

    return {
      price: pair.priceUsd,
      priceChange: pair.priceChange.h1,
      liquidity: pair.liquidity.usd,
      volume: pair.volume.h24,
      pair: `${pair.baseToken.symbol}/${pair.quoteToken.symbol}`,
      fdv: pair.fdv || 0,
      holders: 'N/A',
      link: `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`
    };
  } catch (error) {
    console.error(`Error fetching DexScreener data for ${token}:`, error);
    return null;
  }
}

// Twitter analysis
async function analyzeTwitter(token) {
  try {
    const response = await twitterClient.v2.search({
      query: `${token} OR $${token} -is:retweet`,
      max_results: 100,
      'tweet.fields': ['public_metrics', 'created_at'],
      expansions: 'author_id',
      'user.fields': ['public_metrics']
    });

    const rateLimit = response.rateLimit;
    console.log(`Rate Limit Info (Analysis): ${rateLimit.remaining}/${rateLimit.limit}, Reset at ${new Date(rateLimit.reset * 1000)}`);

    let influencers = 0;
    let totalLikes = 0;
    let totalRetweets = 0;
    const tweets = response.data.data || [];
    const mentionCount = tweets.length;
    const users = response.data.includes?.users || [];
    const sentimentAnalyzer = new natural.SentimentAnalyzer('English', natural.PorterStemmer, 'afinn');
    let sentimentScore = 0;
    let tweetCountForSentiment = 0;

    for (const tweet of tweets) {
      const { like_count, retweet_count } = tweet.public_metrics;
      totalLikes += like_count || 0;
      totalRetweets += retweet_count || 0;

      const user = users.find(u => u.id === tweet.author_id);
      const followers = user?.public_metrics?.followers_count || 0;
      if (followers >= CONFIG.influencerThreshold) influencers++;

      const score = sentimentAnalyzer.getSentiment(tweet.text.split(' '));
      if (score !== 0) {
        sentimentScore += score;
        tweetCountForSentiment++;
      }
    }

    const sentiment = tweetCountForSentiment > 0
      ? (sentimentScore / tweetCountForSentiment > 0 ? 'Positive' : 'Negative')
      : 'Neutral';

    return {
      influencers,
      mentionCount,
      likes: totalLikes,
      retweets: totalRetweets,
      sentiment,
      link: `https://twitter.com/search?q=${encodeURIComponent(token)}`
    };
  } catch (error) {
    if (error.code === 429) {
      const resetTime = error.rateLimit.reset * 1000;
      const waitTime = resetTime - Date.now();
      console.log(`Rate limit hit (Analysis). Waiting ${Math.ceil(waitTime / 60000)} minutes until ${new Date(resetTime)}`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return await analyzeTwitter(token);
    }
    console.error(`Error analyzing Twitter for ${token}:`, error);
    return { influencers: 0, mentionCount: 0, likes: 0, retweets: 0, sentiment: 'N/A', link: '' };
  }
}

// Send Telegram alert with filters
async function sendAlert(listing, tokenData, twitterData, fundamentals) {
  if (!tokenData || !twitterData) return;

  const passesFilters =
    tokenData.liquidity >= CONFIG.filters.minLiquidity &&
    tokenData.volume >= CONFIG.filters.minVolume &&
    tokenData.fdv >= CONFIG.filters.minFDV &&
    twitterData.influencers >= CONFIG.filters.minInfluencers &&
    twitterData.mentionCount >= CONFIG.filters.minMentions &&
    twitterData.sentiment === 'Positive' &&
    fundamentals.team !== 'Not found' &&
    fundamentals.useCase !== 'Vague';

  if (!passesFilters) {
    console.log(`${listing.token} didn’t pass filters`);
    return;
  }

  const message = `
🚨 High-Potential Token Alert 🚨

Token: $${listing.token} (${listing.title})
Price: $${tokenData.price} (${tokenData.priceChange}% in 1h)
Liquidity: $${tokenData.liquidity}
Volume: $${tokenData.volume} (24h)
FDV: $${tokenData.fdv}

📊 DexScreener Data:
- Pair: ${tokenData.pair}
- Holders: ${tokenData.holders} (Manual Check)

🐦 Twitter Analysis:
- Influencers: ${twitterData.influencers} (≥${CONFIG.influencerThreshold} followers)
- Mentions: ${twitterData.mentionCount}
- Engagement: ${twitterData.likes} likes, ${twitterData.retweets} retweets
- Sentiment: ${twitterData.sentiment}

🔍 Fundamentals:
- Team: ${fundamentals.team}
- Use Case: ${fundamentals.useCase}

🔗 Links:
- DexScreener: ${tokenData.link}
- Twitter: ${twitterData.link}
- Announcement: ${listing.link}
  `;

  try {
    await telegramBot.sendMessage(CONFIG.telegram.chatId, message.trim());
    processedTokens.add(listing.token);
    console.log(`Alert sent for ${listing.token}`);
  } catch (error) {
    console.error('Error sending Telegram alert:', error);
  }
}

// Main function
async function runTool() {
  console.log(`Checking ${CONFIG.listingAccount} for new MEXC listings...`);
  const newListings = await fetchNewListings();

  for (const listing of newListings) {
    console.log(`Processing ${listing.token}...`);
    const tokenData = await fetchTokenData(listing.token);
    const twitterData = await analyzeTwitter(listing.token);
    const fundamentals = await fetchFundamentals(listing);

    await sendAlert(listing, tokenData, twitterData, fundamentals);
  }
}

// Run every 30 minutes
setInterval(runTool, 30 * 60 * 1000);
runTool();