/* 層級：level1 大類 → level2 子分類 → level3 連結 */
const PORTAL = [
  {
    id: "search", name: "搜尋", icon: "🔍",
    groups: [
      { name: "通用搜尋", sites: [
        { name: "Google", url: "https://www.google.com" },
        { name: "Bing", url: "https://www.bing.com" },
        { name: "DuckDuckGo", url: "https://duckduckgo.com" },
        { name: "Yahoo 奇摩", url: "https://tw.search.yahoo.com" },
        { name: "Yandex", url: "https://yandex.com" },
        { name: "SearXNG", url: "https://searx.be" }
      ]},
      { name: "隱私搜尋", sites: [
        { name: "Brave", url: "https://search.brave.com" },
        { name: "Startpage", url: "https://www.startpage.com" },
        { name: "Ecosia", url: "https://www.ecosia.org" },
        { name: "Mojeek", url: "https://www.mojeek.com" },
        { name: "Qwant", url: "https://www.qwant.com" }
      ]},
      { name: "AI搜尋", sites: [
        { name: "Perplexity", url: "https://www.perplexity.ai" },
        { name: "You.com", url: "https://you.com" },
        { name: "Phind", url: "https://www.phind.com" },
        { name: "Andi", url: "https://andisearch.com" },
        { name: "GigaBlast", url: "https://gigablast.com" }
      ]},
      { name: "購物比價", sites: [
        { name: "Google Shopping", url: "https://shopping.google.com" },
        { name: "比價網", url: "https://www.price.com.tw" },
        { name: "蝦皮比價", url: "https://www.shopee.tw" },
        { name: "momo 搜尋", url: "https://www.momoshop.com.tw" },
        { name: "Buyzilla", url: "https://www.buyzilla.com" }
      ]},
      { name: "影音圖片", sites: [
        { name: "Google 圖片", url: "https://images.google.com" },
        { name: "YouTube", url: "https://www.youtube.com" },
        { name: "Vimeo", url: "https://vimeo.com" },
        { name: "Unsplash", url: "https://unsplash.com" },
        { name: "Flickr", url: "https://www.flickr.com" }
      ]}
    ]
  },
  {
    id: "tech", name: "科技", icon: "💻",
    groups: [
      { name: "AI工具", sites: [
        { name: "ChatGPT", url: "https://chat.openai.com" },
        { name: "Claude", url: "https://claude.ai" },
        { name: "Gemini", url: "https://gemini.google.com" },
        { name: "Copilot", url: "https://copilot.microsoft.com" },
        { name: "Grok", url: "https://grok.com" },
        { name: "Kimi", url: "https://kimi.com" },
        { name: "DeepSeek", url: "https://chat.deepseek.com" },
        { name: "Mistral", url: "https://chat.mistral.ai" },
        { name: "Hugging Face", url: "https://huggingface.co" },
        { name: "Replicate", url: "https://replicate.com" },
        { name: "Poe", url: "https://poe.com" },
        { name: "OpenRouter", url: "https://openrouter.ai" },
        { name: "Ollama", url: "https://ollama.com" },
        { name: "LM Studio", url: "https://lmstudio.ai" }
      ]},
      { name: "程式開發", sites: [
        { name: "GitHub", url: "https://github.com" },
        { name: "GitLab", url: "https://gitlab.com" },
        { name: "Bitbucket", url: "https://bitbucket.org" },
        { name: "Codeberg", url: "https://codeberg.org" },
        { name: "Stack Overflow", url: "https://stackoverflow.com" },
        { name: "MDN", url: "https://developer.mozilla.org" },
        { name: "DevDocs", url: "https://devdocs.io" },
        { name: "Can I use", url: "https://caniuse.com" },
        { name: "npm", url: "https://www.npmjs.com" },
        { name: "PyPI", url: "https://pypi.org" },
        { name: "crates.io", url: "https://crates.io" },
        { name: "NuGet", url: "https://www.nuget.org" },
        { name: "Maven Central", url: "https://central.sonatype.com" },
        { name: "RubyGems", url: "https://rubygems.org" }
      ]},
      { name: "前端框架", sites: [
        { name: "React", url: "https://react.dev" },
        { name: "Vue", url: "https://vuejs.org" },
        { name: "Svelte", url: "https://svelte.dev" },
        { name: "Angular", url: "https://angular.dev" },
        { name: "Next.js", url: "https://nextjs.org" },
        { name: "Nuxt", url: "https://nuxt.com" },
        { name: "Tailwind", url: "https://tailwindcss.com" },
        { name: "Vite", url: "https://vite.dev" },
        { name: "Bootstrap", url: "https://getbootstrap.com" }
      ]},
      { name: "後端部署", sites: [
        { name: "Cloudflare", url: "https://dash.cloudflare.com" },
        { name: "Vercel", url: "https://vercel.com" },
        { name: "Netlify", url: "https://www.netlify.com" },
        { name: "Render", url: "https://render.com" },
        { name: "Fly.io", url: "https://fly.io" },
        { name: "Railway", url: "https://railway.app" },
        { name: "Heroku", url: "https://heroku.com" },
        { name: "Supabase", url: "https://supabase.com" },
        { name: "PlanetScale", url: "https://planetscale.com" },
        { name: "Prisma", url: "https://www.prisma.io" }
      ]},
      { name: "雲端主機", sites: [
        { name: "AWS", url: "https://console.aws.amazon.com" },
        { name: "Google Cloud", url: "https://console.cloud.google.com" },
        { name: "Azure", url: "https://portal.azure.com" },
        { name: "DigitalOcean", url: "https://cloud.digitalocean.com" },
        { name: "Hetzner", url: "https://console.hetzner.cloud" },
        { name: "Linode", url: "https://cloud.linode.com" },
        { name: "Docker Hub", url: "https://hub.docker.com" },
        { name: "Namecheap", url: "https://www.namecheap.com" },
        { name: "Cloudflare Registrar", url: "https://domains.cloudflare.com" }
      ]},
      { name: "測試除錯", sites: [
        { name: "Regex101", url: "https://regex101.com" },
        { name: "JSON Formatter", url: "https://jsonformatter.org" },
        { name: "CrackStation", url: "https://crackstation.net" },
        { name: "Postman", url: "https://www.postman.com" },
        { name: "Insomnia", url: "https://insomnia.rest" },
        { name: "httpbin", url: "https://httpbin.org" },
        { name: "Carbon", url: "https://carbon.now.sh" },
        { name: "Excalidraw", url: "https://excalidraw.com" }
      ]},
      { name: "官方文件", sites: [
        { name: "Google Developers", url: "https://developers.google.com" },
        { name: "Microsoft Learn", url: "https://learn.microsoft.com" },
        { name: "Apple Developer", url: "https://developer.apple.com" },
        { name: "AWS Docs", url: "https://docs.aws.amazon.com" },
        { name: "Rust Book", url: "https://doc.rust-lang.org/book" },
        { name: "Go Docs", url: "https://go.dev/doc" },
        { name: "Python Docs", url: "https://docs.python.org" },
        { name: "Node.js Docs", url: "https://nodejs.org/docs" },
        { name: "Kubernetes", url: "https://kubernetes.io/docs" }
      ]}
    ]
  },
  {
    id: "news", name: "新聞", icon: "📰",
    groups: [
      { name: "中文新聞", sites: [
        { name: "Yahoo 奇摩新聞", url: "https://tw.news.yahoo.com" },
        { name: "中時新聞", url: "https://www.chinatimes.com" },
        { name: "聯合新聞網", url: "https://udn.com" },
        { name: "自由時報", url: "https://news.ltn.com.tw" },
        { name: "蘋果日報", url: "https://www.appledaily.com" },
        { name: "TVBS", url: "https://news.tvbs.com.tw" },
        { name: "中央社", url: "https://www.cna.com.tw" },
        { name: "新頭殼", url: "https://www.newtalk.tw" }
      ]},
      { name: "國際新聞", sites: [
        { name: "BBC", url: "https://www.bbc.com/news" },
        { name: "Reuters", url: "https://www.reuters.com" },
        { name: "AP News", url: "https://apnews.com" },
        { name: "The Guardian", url: "https://www.theguardian.com" },
        { name: "NYT", url: "https://www.nytimes.com" },
        { name: "WSJ", url: "https://www.wsj.com" },
        { name: "Al Jazeera", url: "https://www.aljazeera.com" },
        { name: "CNN", url: "https://edition.cnn.com" }
      ]},
      { name: "財經新聞", sites: [
        { name: "鉅亨網", url: "https://news.cnyes.com" },
        { name: "MoneyDJ", url: "https://www.moneydj.com" },
        { name: "經濟日報", url: "https://money.udn.com" },
        { name: "工商時報", url: "https://www.ctee.com.tw" },
        { name: "Investing", url: "https://www.investing.com" },
        { name: "Anue鉅亨理財", url: "https://news.cnyes.com/finance" }
      ]},
      { name: "科技新聞", sites: [
        { name: "The Verge", url: "https://www.theverge.com" },
        { name: "TechCrunch", url: "https://techcrunch.com" },
        { name: "Ars Technica", url: "https://arstechnica.com" },
        { name: "Hacker News", url: "https://news.ycombinator.com" },
        { name: "Wired", url: "https://www.wired.com" },
        { name: "9to5Mac", url: "https://9to5mac.com" },
        { name: "Engadget", url: "https://www.engadget.com" },
        { name: "36Kr", url: "https://36kr.com" }
      ]}
    ]
  },
  {
    id: "social", name: "社群", icon: "💬",
    groups: [
      { name: "社交網路", sites: [
        { name: "Facebook", url: "https://www.facebook.com" },
        { name: "Instagram", url: "https://www.instagram.com" },
        { name: "X (Twitter)", url: "https://x.com" },
        { name: "Threads", url: "https://www.threads.net" },
        { name: "TikTok", url: "https://www.tiktok.com" },
        { name: "小紅書", url: "https://www.xiaohongshu.com" },
        { name: "微博", url: "https://weibo.com" }
      ]},
      { name: "論壇頻道", sites: [
        { name: "Reddit", url: "https://www.reddit.com" },
        { name: "Discord", url: "https://discord.com/app" },
        { name: "Telegram", url: "https://web.telegram.org" },
        { name: "LINE", url: "https://line.me" },
        { name: "Signal", url: "https://signal.org" },
        { name: "Mastodon", url: "https://joinmastodon.org" },
        { name: "Medium", url: "https://medium.com" },
        { name: "Substack", url: "https://substack.com" }
      ]},
      { name: "台灣社群", sites: [
        { name: "PTT", url: "https://www.ptt.cc" },
        { name: "Dcard", url: "https://www.dcard.tw" },
        { name: "巴哈姆特", url: "https://www.gamer.com.tw" },
        { name: "Mobile01", url: "https://www.mobile01.com" },
        { name: "iT 邦幫忙", url: "https://ithelp.ithome.com.tw" },
        { name: "香港討論區", url: "https://www.lihkg.com" },
        { name: "蘋果討論區", url: "https://discussions.apple.com" },
        { name: "電腦王阿達", url: "https://www.ajax.com.tw" }
      ]},
      { name: "職場活動", sites: [
        { name: "LinkedIn", url: "https://www.linkedin.com" },
        { name: "104 人力銀行", url: "https://www.104.com.tw" },
        { name: "1111 人力銀行", url: "https://www.1111.com.tw" },
        { name: "CakeResume", url: "https://www.cakeresume.com" },
        { name: "Meetup", url: "https://www.meetup.com" },
        { name: "Eventbrite", url: "https://www.eventbrite.com" }
      ]}
    ]
  },
  {
    id: "wiki", name: "知識", icon: "📚",
    groups: [
      { name: "百科全書", sites: [
        { name: "維基百科", url: "https://zh.wikipedia.org" },
        { name: "Wikipedia", url: "https://en.wikipedia.org" },
        { name: "萌典", url: "https://www.moedict.tw" },
        { name: "百度百科", url: "https://baike.baidu.com" },
        { name: "Britannica", url: "https://www.britannica.com" },
        { name: "維基文庫", url: "https://zh.wikisource.org" }
      ]},
      { name: "辭典翻譯", sites: [
        { name: "教育部國語辭典", url: "https://dict.revised.moe.edu.tw" },
        { name: "維基詞典", url: "https://zh.wiktionary.org" },
        { name: "Merriam-Webster", url: "https://www.merriam-webster.com" },
        { name: "Cambridge", url: "https://dictionary.cambridge.org" },
        { name: "dict.cc", url: "https://www.dict.cc" },
        { name: "漢典", url: "https://www.zdic.net" }
      ]},
      { name: "學術研究", sites: [
        { name: "Google Scholar", url: "https://scholar.google.com" },
        { name: "arXiv", url: "https://arxiv.org" },
        { name: "PubMed", url: "https://pubmed.ncbi.nlm.nih.gov" },
        { name: "Semantic Scholar", url: "https://www.semanticscholar.org" },
        { name: "ACM DL", url: "https://dl.acm.org" },
        { name: "IEEE Xplore", url: "https://ieeexplore.ieee.org" },
        { name: "JSTOR", url: "https://www.jstor.org" },
        { name: "國家圖書館", url: "https://www.ncl.edu.tw" },
        { name: "臺灣博碩士", url: "https://ndltd.ncl.edu.tw" }
      ]},
      { name: "影音資料庫", sites: [
        { name: "IMDb", url: "https://www.imdb.com" },
        { name: "Letterboxd", url: "https://letterboxd.com" },
        { name: "TMDB", url: "https://www.themoviedb.org" },
        { name: "Discogs", url: "https://www.discogs.com" },
        { name: "Goodreads", url: "https://www.goodreads.com" },
        { name: "OpenLibrary", url: "https://openlibrary.org" }
      ]}
    ]
  },
  {
    id: "work", name: "工作", icon: "🗂️",
    groups: [
      { name: "協作專案", sites: [
        { name: "Notion", url: "https://www.notion.so" },
        { name: "Google Docs", url: "https://docs.google.com" },
        { name: "Microsoft 365", url: "https://www.office.com" },
        { name: "Google Calendar", url: "https://calendar.google.com" },
        { name: "Trello", url: "https://trello.com" },
        { name: "Jira", url: "https://www.atlassian.com/software/jira" },
        { name: "Asana", url: "https://asana.com" },
        { name: "Airtable", url: "https://www.airtable.com" },
        { name: "Miro", url: "https://miro.com" }
      ]},
      { name: "設計工具", sites: [
        { name: "Figma", url: "https://www.figma.com" },
        { name: "Canva", url: "https://www.canva.com" },
        { name: "Framer", url: "https://www.framer.com" },
        { name: "Adobe", url: "https://www.adobe.com" },
        { name: "Sketch", url: "https://www.sketch.com" }
      ]},
      { name: "雲端硬碟", sites: [
        { name: "Google Drive", url: "https://drive.google.com" },
        { name: "Dropbox", url: "https://www.dropbox.com" },
        { name: "OneDrive", url: "https://onedrive.live.com" },
        { name: "iCloud", url: "https://www.icloud.com" },
        { name: "MEGA", url: "https://mega.nz" },
        { name: "WeTransfer", url: "https://wetransfer.com" }
      ]},
      { name: "待辦密碼", sites: [
        { name: "Todoist", url: "https://todoist.com" },
        { name: "TickTick", url: "https://ticktick.com" },
        { name: "Notion Calendar", url: "https://www.notion.so/product/calendar" },
        { name: "1Password", url: "https://1password.com" },
        { name: "Bitwarden", url: "https://bitwarden.com" },
        { name: "KeePassXC", url: "https://keepassxc.org" }
      ]}
    ]
  },
  {
    id: "fun", name: "娛樂", icon: "🎬",
    groups: [
      { name: "影視串流", sites: [
        { name: "Netflix", url: "https://www.netflix.com" },
        { name: "Disney+", url: "https://www.disneyplus.com" },
        { name: "Prime Video", url: "https://www.primevideo.com" },
        { name: "HBO Max", url: "https://www.max.com" },
        { name: "Hulu", url: "https://www.hulu.com" },
        { name: "Apple TV+", url: "https://tv.apple.com" },
        { name: "愛奇藝", url: "https://www.iqiyi.com" }
      ]},
      { name: "動漫影音", sites: [
        { name: "YouTube", url: "https://www.youtube.com" },
        { name: "巴哈姆特動畫瘋", url: "https://anime.gamer.com.tw" },
        { name: "Bilibili", url: "https://www.bilibili.com" },
        { name: "MyAnimeList", url: "https://myanimelist.net" },
        { name: "AniList", url: "https://anilist.co" },
        { name: "MangaDex", url: "https://mangadex.org" },
        { name: "LINE Manga", url: "https://manga.line.me" }
      ]},
      { name: "音樂頻道", sites: [
        { name: "Spotify", url: "https://open.spotify.com" },
        { name: "Apple Music", url: "https://music.apple.com" },
        { name: "YouTube Music", url: "https://music.youtube.com" },
        { name: "SoundCloud", url: "https://soundcloud.com" },
        { name: "Bandcamp", url: "https://bandcamp.com" },
        { name: "Twitch", url: "https://www.twitch.tv" }
      ]},
      { name: "遊戲平台", sites: [
        { name: "Steam", url: "https://store.steampowered.com" },
        { name: "Epic Games", url: "https://store.epicgames.com" },
        { name: "PlayStation", url: "https://store.playstation.com" },
        { name: "Xbox", url: "https://www.xbox.com/games/store" },
        { name: "Nintendo", url: "https://www.nintendo.com" },
        { name: "itch.io", url: "https://itch.io" }
      ]}
    ]
  },
  {
    id: "life", name: "生活", icon: "🛒",
    groups: [
      { name: "線上購物", sites: [
        { name: "蝦皮購物", url: "https://www.shopee.tw" },
        { name: "momo", url: "https://www.momoshop.com.tw" },
        { name: "PChome 24h", url: "https://24h.pchome.com.tw" },
        { name: "露天拍賣", url: "https://www.ruten.com.tw" },
        { name: "博客來", url: "https://www.books.com.tw" },
        { name: "Amazon", url: "https://www.amazon.com" },
        { name: "Costco", url: "https://www.costco.com.tw" },
        { name: "全聯", url: "https://www.px.com.tw" }
      ]},
      { name: "飲食外送", sites: [
        { name: "foodpanda", url: "https://www.foodpanda.tw" },
        { name: "Uber Eats", url: "https://www.ubereats.com/tw" },
        { name: "無印良品", url: "https://www.muji.com.tw" },
        { name: "摩斯漢堡", url: "https://www.mos.com.tw" },
        { name: "鼎泰豐", url: "https://www.din-taifung.com.tw" }
      ]},
      { name: "旅遊交通", sites: [
        { name: "Google Maps", url: "https://maps.google.com" },
        { name: "台鐵", url: "https://www.railway.gov.tw" },
        { name: "台灣高鐵", url: "https://www.thsrc.com.tw" },
        { name: "Uber", url: "https://www.uber.com" },
        { name: "Airbnb", url: "https://www.airbnb.com" },
        { name: "Booking", url: "https://www.booking.com" },
        { name: "Skyscanner", url: "https://www.skyscanner.com.tw" },
        { name: "台灣旅遊網", url: "https://eng.taiwan.net.tw" }
      ]},
      { name: "金融行情", sites: [
        { name: "台灣銀行匯率", url: "https://rate.bot.com.tw" },
        { name: "中央銀行", url: "https://www.cbc.gov.tw" },
        { name: "證券交易所", url: "https://www.twse.com.tw" },
        { name: "Yahoo 股市", url: "https://tw.stock.yahoo.com" },
        { name: "Investing", url: "https://www.investing.com" },
        { name: "Finimize", url: "https://finimize.com" }
      ]},
      { name: "政府服務", sites: [
        { name: "台灣政府入口", url: "https://www.gov.tw" },
        { name: "健保署", url: "https://www.nhi.gov.tw" },
        { name: "國稅局", url: "https://www.etax.nat.gov.tw" },
        { name: "財政部", url: "https://www.mof.gov.tw" },
        { name: "勞動部", url: "https://www.mol.gov.tw" },
        { name: "警政署", url: "https://www.npa.gov.tw" },
        { name: "實價登錄", url: "https://plvr.land.moi.gov.tw" },
        { name: "MyData", url: "https://www.mydata.org.tw" }
      ]}
    ]
  },
  {
    id: "design", name: "設計", icon: "🎨",
    groups: [
      { name: "設計作品", sites: [
        { name: "Dribbble", url: "https://dribbble.com" },
        { name: "Behance", url: "https://www.behance.net" },
        { name: "Awwwards", url: "https://www.awwwards.com" },
        { name: "SiteInspire", url: "https://www.siteinspire.com" },
        { name: "Land-book", url: "https://land-book.com" },
        { name: "Pinterest", url: "https://www.pinterest.com" }
      ]},
      { name: "圖片素材", sites: [
        { name: "Unsplash", url: "https://unsplash.com" },
        { name: "Pexels", url: "https://www.pexels.com" },
        { name: "Pixabay", url: "https://pixabay.com" },
        { name: "Picjumbo", url: "https://picjumbo.com" },
        { name: "Burst", url: "https://burst.shopify.com" }
      ]},
      { name: "字型圖示", sites: [
        { name: "Google Fonts", url: "https://fonts.google.com" },
        { name: "Font Awesome", url: "https://fontawesome.com" },
        { name: "Font Squirrel", url: "https://www.fontsquirrel.com" },
        { name: "Iconify", url: "https://iconify.design" },
        { name: "Lucide", url: "https://lucide.dev" },
        { name: "Phosphor", url: "https://phosphoricons.com" },
        { name: "Flaticon", url: "https://www.flaticon.com" },
        { name: "LottieFiles", url: "https://lottiefiles.com" }
      ]},
      { name: "配色靈感", sites: [
        { name: "Coolors", url: "https://coolors.co" },
        { name: "Adobe Color", url: "https://color.adobe.com" },
        { name: "ColorHunt", url: "https://colorhunt.co" },
        { name: "Happy Hues", url: "https://www.happyhues.co" }
      ]}
    ]
  },
  {
    id: "tools", name: "工具", icon: "🧰",
    groups: [
      { name: "轉檔處理", sites: [
        { name: "Google 翻譯", url: "https://translate.google.com" },
        { name: "TinyPNG", url: "https://tinypng.com" },
        { name: "Squoosh", url: "https://squoosh.app" },
        { name: "iLovePDF", url: "https://www.ilovepdf.com" },
        { name: "Convertio", url: "https://convertio.co" },
        { name: "Remove.bg", url: "https://www.remove.bg" },
        { name: "Clideo", url: "https://clideo.com" }
      ]},
      { name: "臨時信箱", sites: [
        { name: "Temp Mail", url: "https://temp-mail.org" },
        { name: "1secmail", url: "https://www.1secmail.com" },
        { name: "Guerrilla Mail", url: "https://www.guerrillamail.com" },
        { name: "EmailOnDeck", url: "https://emailondeck.com" }
      ]},
      { name: "網路查詢", sites: [
        { name: "Speedtest", url: "https://www.speedtest.net" },
        { name: "DownDetector", url: "https://downdetector.com" },
        { name: "Wayback Machine", url: "https://web.archive.org" },
        { name: "Who is", url: "https://who.is" },
        { name: "DNS Lookup", url: "https://nslookup.io" },
        { name: "urlscan", url: "https://urlscan.io" }
      ]},
      { name: "寫作輔助", sites: [
        { name: "Grammarly", url: "https://www.grammarly.com" },
        { name: "Hemingway", url: "https://hemingwayapp.com" },
        { name: "Otter", url: "https://otter.ai" },
        { name: "Type Scale", url: "https://typescale.com" },
        { name: "Diffchecker", url: "https://www.diffchecker.com" }
      ]}
    ]
  },
  {
    id: "learn", name: "學習", icon: "🎓",
    groups: [
      { name: "線上課程", sites: [
        { name: "Coursera", url: "https://www.coursera.org" },
        { name: "edX", url: "https://www.edx.org" },
        { name: "Udemy", url: "https://www.udemy.com" },
        { name: "FutureLearn", url: "https://www.futurelearn.com" },
        { name: "OpenClassrooms", url: "https://www.openclassrooms.com" }
      ]},
      { name: "免費資源", sites: [
        { name: "freeCodeCamp", url: "https://www.freecodecamp.org" },
        { name: "Khan Academy", url: "https://www.khanacademy.org" },
        { name: "MIT OCW", url: "https://ocw.mit.edu" },
        { name: "The Odin Project", url: "https://www.theodinproject.com" },
        { name: "NTU MOOC", url: "https://www.ntu.edu.tw/education/learning/online-courses" },
        { name: "OpenLearn", url: "https://www.openlearn.ac.uk" }
      ]},
      { name: "練習競賽", sites: [
        { name: "LeetCode", url: "https://leetcode.com" },
        { name: "Codewars", url: "https://www.codewars.com" },
        { name: "Exercism", url: "https://exercism.org" },
        { name: "HackerRank", url: "https://www.hackerrank.com" },
        { name: "Codeforces", url: "https://codeforces.com" },
        { name: "AtCoder", url: "https://atcoder.jp" },
        { name: "Kaggle", url: "https://www.kaggle.com" }
      ]},
      { name: "語言學習", sites: [
        { name: "Duolingo", url: "https://www.duolingo.com" },
        { name: "Busuu", url: "https://www.busuu.com" },
        { name: "Rosetta Stone", url: "https://www.rosettastone.com" },
        { name: "italki", url: "https://www.italki.com" },
        { name: "Preply", url: "https://preply.com" },
        { name: "HelloTalk", url: "https://www.hellotalk.com" }
      ]}
    ]
  }
];

const SEARCH_ENGINES = [
  { name: "Google", url: "https://www.google.com/search?q=" },
  { name: "Bing", url: "https://www.bing.com/search?q=" },
  { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
  { name: "Brave", url: "https://search.brave.com/search?q=" }
];

const el = id => document.getElementById(id);
const mainEl = el("main");
const emptyEl = el("empty");
const crumbEl = el("crumb");
const qInput = el("q");
const form = el("searchForm");
const themeBtn = el("themeToggle");
const countEl = el("count");
const segEl = el("seg");

/* 首頁每個分類最多顯示的子分類標籤數，其餘要進分類才看得到 */
const TAGS_PER_CARD = 4;

/* 目前檢視：第一層 all / 第二層 catId / 第三層 catId+groupName */
let view = { cat: null, group: null };
let kw = "";
let mode = "site"; /* site = 站內搜尋 / google = 交給 Google 搜尋 */

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function siteMatch(s) {
  if (!kw) return true;
  return s.name.toLowerCase().includes(kw) || s.url.toLowerCase().includes(kw);
}

function groupSites(g) {
  return g.sites.filter(siteMatch);
}

/* ---------- 第一層：分類總覽 ---------- */
function renderLevel1() {
  const cats = PORTAL.map(c => {
    const n = c.groups.reduce((a, g) => a + g.sites.length, 0);
    const names = c.groups.map(g => g.name);
    return `<a class="cat-card" href="#cat=${c.id}">
      <div class="cat-card-hd"><span class="cat-icon">${c.icon}</span><span class="cat-name">${esc(c.name)}</span><span class="cat-n">${n}</span></div>
      <div class="cat-card-bd">
        ${names.slice(0, TAGS_PER_CARD).map(g => `<span class="tag">${esc(g)}</span>`).join("")}
      </div>
    </a>`;
  });
  return `<div class="cat-grid">${cats.join("")}</div>`;
}

/* ---------- 第二層：某大類下的子分類（卡片式，含所屬分類） ---------- */
function renderLevel2(cat) {
  const groups = cat.groups.map(g => {
    const sites = groupSites(g);
    const preview = sites.slice(0, 4).map(s => `<a class="tag tag-lk" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="go ${esc(s.url.replace(/^https?:\/\//, ""))}">${esc(s.name)}</a>`).join("");
    return `<div class="sub-card" data-href="#cat=${cat.id}&grp=${encodeURIComponent(g.name)}">
      <div class="sub-hd">
        <span class="sub-cat">${cat.icon} ${esc(cat.name)}</span>
        <span class="sub-name">${esc(g.name)}</span>
        <span class="sub-n">${sites.length}</span>
      </div>
      <div class="sub-bd">${preview}</div>
    </div>`;
  });
  return `<div class="sub-grid">${groups.join("")}</div>`;
}

/* ---------- 第三層：某子分類的連結（點站名直接前往該站） ---------- */
function renderLevel3(cat, group) {
  const sites = groupSites(group);
  return `<div class="lk-grid">${sites.map(s =>
    `<a class="lk" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">
       <span class="lk-name">${esc(s.name)}</span>
       <span class="lk-url">${esc(s.url.replace(/^https?:\/\//, ""))}</span>
     </a>`).join("")}</div>`;
}

/* ---------- 站內搜尋結果：分類命中 + 網站命中 ---------- */
function renderSearch() {
  const catHits = PORTAL.filter(c => c.name.toLowerCase().includes(kw));
  const grpHits = [];
  const siteHits = [];
  PORTAL.forEach(c => {
    const catHit = catHits.includes(c);
    c.groups.forEach(g => {
      const grpHit = g.name.toLowerCase().includes(kw);
      if (grpHit) grpHits.push({ cat: c, g });
      g.sites.forEach(s => {
        if (siteMatch(s)) siteHits.push({ cat: c, g, s });
      });
    });
  });

  const parts = [];

  if (catHits.length) {
    parts.push(`<h2 class="sec-title">分類</h2><div class="cat-grid">` + catHits.map(c =>
      `<a class="cat-card" href="#cat=${c.id}">
        <div class="cat-card-hd"><span class="cat-icon">${c.icon}</span><span class="cat-name">${esc(c.name)}</span><span class="cat-n">${c.groups.reduce((a, g) => a + g.sites.length, 0)}</span></div>
        <div class="cat-card-bd">${c.groups.slice(0, TAGS_PER_CARD).map(g => `<span class="tag">${esc(g.name)}</span>`).join("")}</div>
      </a>`).join("") + `</div>`);
  }

  if (grpHits.length) {
    parts.push(`<h2 class="sec-title">子分類</h2><div class="sub-grid">` + grpHits.map(({ cat, g }) =>
      `<div class="sub-card" data-href="#cat=${cat.id}&grp=${encodeURIComponent(g.name)}">
        <div class="sub-hd">
          <span class="sub-cat">${cat.icon} ${esc(cat.name)}</span>
          <span class="sub-name">${esc(g.name)}</span>
          <span class="sub-n">${g.sites.length}</span>
        </div>
        <div class="sub-bd">${g.sites.slice(0, 4).map(s => `<a class="tag tag-lk" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="go ${esc(s.url.replace(/^https?:\/\//, ""))}">${esc(s.name)}</a>`).join("")}</div>
      </div>`).join("") + `</div>`);
  }

  if (siteHits.length) {
    parts.push(`<h2 class="sec-title">網站</h2><div class="lk-grid">` + siteHits.map(({ s }) =>
      `<a class="lk" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">
         <span class="lk-name">${esc(s.name)}</span>
         <span class="lk-url">${esc(s.url.replace(/^https?:\/\//, ""))}</span>
       </a>`).join("") + `</div>`);
  }

  return parts.join("");
}

/* ---------- Google 搜尋模式 ---------- */
function renderGoogle() {
  const q = qInput.value.trim();
  if (!q) return `<div class="gpanel"><span class="gpanel-t">輸入關鍵字，交給 Google 搜尋整個網路</span></div>`;
  const gurl = "https://www.google.com/search?q=" + encodeURIComponent(q);
  return `<div class="gpanel">
    <span class="gpanel-t">以 Google 搜尋「<b>${esc(q)}</b>」</span>
    <a class="btn-google" href="${gurl}" target="_blank" rel="noopener noreferrer">前往 Google 搜尋 ›</a>
  </div>`;
}

function renderCrumb() {
  const parts = [`<a href="#" class="cb">首頁</a>`];
  if (view.cat) {
    const c = PORTAL.find(x => x.id === view.cat);
    parts.push(c ? `<a href="#cat=${c.id}" class="cb">${c.icon} ${esc(c.name)}</a>` : "");
    if (view.group) parts.push(`<span class="cb cur">${esc(view.group.name)}</span>`);
  }
  crumbEl.innerHTML = parts.filter(Boolean).join("<span class='sep'>/</span>");
  crumbEl.hidden = !view.cat && !kw;
}

function render() {
  let html = "";
  let shown = 0;

  if (mode === "google") {
    html = renderGoogle();
    shown = 0;
  } else if (kw) {
    html = renderSearch();
    shown = (html.match(/class="lk"/g) || []).length;
  } else if (!view.cat) {
    html = renderLevel1();
    shown = PORTAL.reduce((a, c) => a + c.groups.reduce((b, g) => b + g.sites.length, 0), 0);
  } else {
    const cat = PORTAL.find(c => c.id === view.cat);
    if (view.group) {
      html = renderLevel3(cat, view.group);
      shown = groupSites(view.group).length;
    } else {
      html = renderLevel2(cat);
      shown = cat.groups.reduce((a, g) => a + groupSites(g).length, 0);
    }
  }

  mainEl.innerHTML = html;
  emptyEl.hidden = html !== "" || mode === "google";
  renderCrumb();

  const total = PORTAL.reduce((a, c) => a + c.groups.reduce((b, g) => b + g.sites.length, 0), 0);
  countEl.textContent = mode === "google"
    ? (kw ? "Google 搜尋模式" : "站內 / Google 搜尋")
    : (kw ? `找到 ${shown} 個網站` : (view.cat ? `顯示 ${shown} / ${total} 個連結` : `共 ${total} 個連結`));
}

function readHash() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ""));
  const params = new URLSearchParams(h);
  const cat = params.get("cat");
  const grp = params.get("grp");
  const q = params.get("q");
  if (q !== null && q !== qInput.value.trim()) {
    qInput.value = q;
    kw = q.trim().toLowerCase();
  } else if (q === null) {
    /* 點了任何連結導覽：清除搜尋狀態 */
    qInput.value = "";
    kw = "";
  }
  view = { cat, group: null };
  if (cat && grp) {
    const c = PORTAL.find(x => x.id === cat);
    if (c) {
      const g = c.groups.find(x => x.name === grp);
      if (g) view.group = g;
    }
  }
}

window.addEventListener("hashchange", () => { readHash(); render(); });

mainEl.addEventListener("click", e => {
  const card = e.target.closest(".cat-card");
  if (card) { e.preventDefault(); location.hash = card.getAttribute("href"); return; }
  if (e.target.closest(".tag-lk")) return; /* tag link: open site directly */
  const sub = e.target.closest(".sub-card");
  if (sub) { location.hash = sub.dataset.href; }
});

qInput.addEventListener("input", () => {
  kw = qInput.value.trim().toLowerCase();
  render();
});

segEl.addEventListener("click", e => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  setMode(btn.dataset.mode);
});

function setMode(m) {
  mode = m;
  segEl.querySelectorAll(".seg-btn").forEach(b => {
    const on = b.dataset.mode === m;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  qInput.placeholder = m === "google" ? "輸入關鍵字，交給 Google 搜尋…" : "搜尋站名、網址或分類…";
  render();
}

form.addEventListener("submit", e => {
  e.preventDefault();
  const raw = qInput.value.trim();
  if (!raw) return;
  if (/^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(raw)) {
    window.open(/^https?:\/\//i.test(raw) ? raw : "https://" + raw, "_blank", "noopener");
    return;
  }
  if (mode === "google") {
    window.open(SEARCH_ENGINES[0].url + encodeURIComponent(raw), "_blank", "noopener");
    return;
  }
  /* 站內搜尋：若沒有相符結果，改用 Google */
  const hit = PORTAL.some(c => c.name.toLowerCase().includes(kw) ||
    c.groups.some(g => g.name.toLowerCase().includes(kw) || g.sites.some(siteMatch)));
  if (!hit) window.open(SEARCH_ENGINES[0].url + encodeURIComponent(raw), "_blank", "noopener");
});

themeBtn.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("portal-theme", next); } catch (_) {}
});

try {
  const saved = localStorage.getItem("portal-theme");
  if (saved) document.documentElement.dataset.theme = saved;
  else if (window.matchMedia("(prefers-color-scheme: dark)").matches)
    document.documentElement.dataset.theme = "dark";
} catch (_) {}

readHash();
render();
