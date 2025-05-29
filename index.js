import { Browser } from "happy-dom";
import ical from "ical-generator";
import fs from "node:fs";
import vm from "node:vm";

class Semaphore {
  #max = 0;
  #counter = 0;
  #waiting = [];

  constructor(max) {
    this.#max = max;
  }

  acquire() {
    if(this.#counter < this.#max) {
      this.#counter++
      return new Promise(resolve => {
        resolve();
      });
    } else {
      return new Promise((resolve, err) => {
        this.#waiting.push({resolve: resolve, err: err});
      });
    }
  }

  release() {
    this.#counter--;
    this.#take();
  }

  purge() {
    let unresolved = this.#waiting.length;
    for (let i = 0; i < unresolved; i++) {
      this.#waiting[i].err('Task has been purged.');
    }
    this.#counter = 0;
    this.#waiting = [];
    return unresolved;
  }

  async with(cb) {
    await this.acquire();
    try {
      return await cb();
    } finally {
      this.release();
    }
  }

  #take() {
    if (this.#waiting.length > 0 && this.#counter < this.#max){
      this.#counter++;
      this.#waiting.shift().resolve();
    }
  }
}

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "Oktober",
  "November",
  "December",
].reduce((acc, month, index) => ({ ...acc, [month]: index }), {});

function parseDate(str) {
  const [, dom, mon, y, time] = str.split(" ");
  const [, h, m] = time.match(/^(\d{1,2}):(\d{2})$/);
  const date = parseInt(dom);
  const monthIdx = months[mon];
  const year = parseInt(y);
  const hour = parseInt(h);
  const minute = parseInt(m);
  // console.log({ today, day, time, date, monthIdx, year, hour, minute });
  return new Date(
    year,
    monthIdx,
    date,
    hour,
    minute
  );
}

async function scrape(page, callback) {
  const title = page.querySelector("h1.Page__heading").textContent.trim();
  const description = page.querySelector("p.Page__description").textContent.trim();
  const runtime = Array.from(page.querySelectorAll(".Film-info__information__value"), node => {
    return node.textContent.match(/\b\d+(?=\s?min\b)/)?.[0];
  }).find(val => val !== null); // runtime in minutes

  const script = Array.from(
    page.querySelectorAll("script:not([src])"),
    node => node.textContent
  ).find(script => script.includes("var articleContext ="));

  const context = {};
  try {
    vm.runInNewContext(script, context);
  } catch (error) {
    // This is expected!
  }

  if (!("searchResults" in context.articleContext))
    return;

  const { articleContext: { searchResults, searchNames, articleId, sToken, pagination: { current_page, total_pages } } } = context;
  console.info("Scraping", title, current_page, "of", total_pages);
  const results = searchResults.map(
    result => Object.fromEntries(searchNames.map(
      (col, i) => [col, result[i]])
    )
  );
  results.forEach(result => {
    const start = parseDate(result.start_date);
    const end = new Date(start.getTime() + (parseInt(runtime) || 0) * 60_000);
    const location = result.venue_name;
    const soldOut = result.availability_status != "S";
    callback({ title, description, start, end, location, soldOut });
  });

  if (parseInt(current_page) < parseInt(total_pages))
    return `https://whatson.bfi.org.uk/Online/default.asp?sToken=${encodeURIComponent(sToken)}&BOset::WScontent::SearchResultsInfo::current_page=${parseInt(current_page) + 1}&doWork::WScontent::getPage=&BOparam::WScontent::getPage::article_id=${encodeURIComponent(articleId)}`;
}

async function main() {
  const calendar = ical({
    name: "BFI"
  });
  const browser = new Browser({
    settings: {
      disableJavaScriptEvaluation: false,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableComputedStyleRendering: true,
      navigation: {
        disableChildPageNavigation: true,
        disableChildFrameNavigation: true,
      },
      navigator: {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:138.0) Gecko/20100101 Firefox/138.0",
        maxTouchPoints: 4,
      },
      fetch: {
        interceptor: {
          beforeAsyncRequest: async ({request, window}) => {
            // Necessary for Cloudfront?
            request.headers.set("Pragma", "no-cache");
          }
        }
      }
    },
  });

  const page = browser.newPage();
  await page.goto("https://whatson.bfi.org.uk/Online/default.asp?BOparam::WScontent::loadArticle::permalink=filmsindex");
  await page.waitUntilComplete();

  const sem = new Semaphore(8);
  const links = page.mainFrame.document.querySelectorAll(".article-container.main-article-body .Rich-text > ul > li > a[href^='article/']");
  console.info(`Found ${links.length} films`);

  if (!links.length) {
    console.error(page.content);
    throw new Error("No film links found");
  }

  await Promise.all(Array.from(links, async (link) => {
    await sem.acquire();
    let url = link.href;
    try {
      while (url) {
        const page = browser.newPage();
        await page.goto(url);
        await page.waitUntilComplete();
        url = await scrape(page.mainFrame.document, ({ title, start, end, description, filmUrl, soldOut }) => {
          calendar.createEvent({
            start,
            end,
            url: link.href,
            summary: title,
            description: `${soldOut ? "[sold out] " : ""}${description}`,
          })
        });
        await page.close();
      }
    } catch(e) {
      console.log({ url });
      throw e;
    } finally {
      sem.release();
    }
  }));

  const dest = process.argv[2] || "out.ics";
  fs.writeFile(dest, calendar.toString(), error => {
    if (error) {
      console.error(error);
    } else {
      console.log(`wrote ${calendar.events().length} events to ${dest}`);
    }
  })

  await browser.close();
}

main();
