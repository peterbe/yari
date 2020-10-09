const fs = require("fs");
const path = require("path");
const cliProgress = require("cli-progress");

const { Client } = require("@elastic/elasticsearch");

const { Document, slugToFolder } = require("../content");
const options = require("../build/build-options");
const { analyzeDocument } = require("./analyze");
const { BUILD_OUT_ROOT } = require("./constants");

const client = new Client({ node: "http://localhost:9200" });

async function analyzeDocuments() {
  const documents = Document.findAll(options);
  const progressBar = new cliProgress.SingleBar(
    {},
    cliProgress.Presets.shades_grey
  );

  if (!documents.count) {
    throw new Error("No documents to build found");
  }

  const translationsOf = new Map();

  const analyzedDocuments = [];

  !options.noProgressbar && progressBar.start(documents.count);
  for (const document of documents.iter()) {
    const outPath = path.join(BUILD_OUT_ROOT, slugToFolder(document.url));
    fs.mkdirSync(outPath, { recursive: true });
    const { translation_of } = document.metadata;

    // If it's a non-en-US document, it'll most likely have a `translation_of`.
    // If so, add it to the map so that when we build the en-US one, we can
    // get an index of the *other* translations available.
    if (translation_of) {
      if (!translationsOf.has(translation_of)) {
        translationsOf.set(translation_of, []);
      }
      translationsOf.get(translation_of).push({
        slug: document.metadata.slug,
        locale: document.metadata.locale,
      });
      // This is a shortcoming. If this is a translated document, we don't have a
      // complete mapping of all other translations. So, the best we can do is
      // at least link to the English version.
      // In 2021, when we refactor localization entirely, this will need to change.
      // Perhaps, then, we'll do a complete scan through all content first to build
      // up the map before we process each one.
      document.translations = [];
    } else {
      document.translations = translationsOf.get(document.metadata.slug);
    }

    const analyzedDocument = await analyzeDocument(document);

    // const outPathFile = path.join(outPath, "index.json");
    // fs.writeFileSync(
    //   outPathFile,
    //   // This is exploiting the fact that renderHTML has the side-effect of mutating builtDocument
    //   // which makes this not great and refactor-worthy
    //   JSON.stringify(analysis)
    // );
    // // There are some archived documents that, due to possible corruption or other
    // // unknown reasons, don't have a list of contributors.
    // if (document.metadata.contributors || !document.isArchive) {
    //   fs.writeFileSync(
    //     path.join(outPath, "contributors.txt"),
    //     renderContributorsTxt(
    //       document.metadata.contributors,
    //       !document.isArchive
    //         ? builtDocument.source.github_url.replace("/blob/", "/commits/")
    //         : null
    //     )
    //   );
    // }

    // for (const { id, html } of liveSamples) {
    //   const liveSamplePath = path.join(outPath, "_samples_", id, "index.html");
    //   fs.mkdirSync(path.dirname(liveSamplePath), { recursive: true });
    //   fs.writeFileSync(liveSamplePath, html);
    // }

    // for (const filePath of fileAttachments) {
    //   // We *could* use symlinks instead. But, there's no point :)
    //   // Yes, a symlink is less disk I/O but it's nominal.
    //   fs.copyFileSync(filePath, path.join(outPath, path.basename(filePath)));
    // }

    // Decide whether it should be indexed (sitemaps, robots meta tag, search-index)
    document.noIndexing =
      (document.isArchive && !document.isTranslated) ||
      document.metadata.slug === "MDN/Kitchensink";

    if (!document.noIndexing) {
      analyzedDocuments.push(analyzedDocument);
    }

    if (!options.noProgressbar) {
      progressBar.increment();
    } else {
      // console.log(outPathFile);
      console.log(document.fileInfo.path);
    }
  }

  !options.noProgressbar && progressBar.stop();

  return analyzedDocuments;
}

if (require.main === module) {
  const t0 = new Date();
  analyzeDocuments()
    .then(async (docs) => {
      const count = docs.length;
      const t1 = new Date();
      const seconds = (t1 - t0) / 1000;
      const took =
        seconds > 60
          ? `${(seconds / 60).toFixed(1)} minutes`
          : `${seconds.toFixed(1)} seconds`;
      console.log(
        `Analyzed ${count.toLocaleString()} documents in ${took}, at a rate of ${(
          count / seconds
        ).toFixed(1)} documents per second.`
      );

      const INDEX_NAME = "mdn_documents";
      await client.indices.create(
        {
          index: INDEX_NAME,
          body: {
            mappings: {
              properties: {
                id: { type: "integer" },
                title: { type: "title" },
                mdn_url: { type: "keyword" },
                slug: { type: "keyword" },
                locale: { type: "keyword" },
                popularity: { type: "float" },
                modified: { type: "date" },
                isArchive: { type: "boolean" },
                isTranslated: { type: "boolean" },
                fileSize: { type: "integer" },
              },
            },
          },
        },
        { ignore: [400] }
      );
      console.log(`Index ${INDEX_NAME} CREATED`);

      const body = docs.flatMap((doc) => [
        { index: { _index: INDEX_NAME } },
        {
          ...doc,
          id: doc.mdn_url,
        },
      ]);
      const { body: bulkResponse } = await client.bulk({ refresh: true, body });

      if (bulkResponse.errors) {
        const erroredDocuments = [];
        // The items array has the same order of the dataset we just indexed.
        // The presence of the `error` key indicates that the operation
        // that we did for the document has failed.
        bulkResponse.items.forEach((action, i) => {
          const operation = Object.keys(action)[0];
          if (action[operation].error) {
            erroredDocuments.push({
              // If the status is 429 it means that you can retry the document,
              // otherwise it's very likely a mapping error, and you should
              // fix the document before to try it again.
              status: action[operation].status,
              error: action[operation].error,
              operation: body[i * 2],
              document: body[i * 2 + 1],
            });
          }
        });
        console.log(erroredDocuments);
      }

      const { body: countIndexed } = await client.count({ index: INDEX_NAME });
      console.log({ countIndexed });
    })
    .catch((error) => {
      console.error("error while analyzing documents:", error);
      process.exit(1);
    });
}
