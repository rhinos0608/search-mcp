const { search_mcp_semantic_jobs } = require('./dist/server.js');

async function test() {
  const opts = {
    query: "low level admin roles sydney australia",
    location: ["Sydney"],
    maxPages: 20,
    topK: 15,
    enforceConstraints: true,
    useJobSpy: true
  };
  const enforceConstraints = opts.enforceConstraints;

  try {
    const result = await search_mcp_semantic_jobs(opts);

    console.log("=== Test Results ===");
    console.log(`Total results: ${result.results.length}`);
    
    const sydneyCount = result.results.filter(r => 
      r.listing.location?.toLowerCase().includes('sydney') ||
      (Array.isArray(r.matchedConstraints) && r.matchedConstraints.includes('location: Sydney'))
    ).length;
    
    console.log(`Sydney jobs found: ${sydneyCount}/${result.results.length}`);
    console.log("\nTop 5 results:");
    result.results.slice(0, 5).forEach((r, i) => {
      console.log(`${i+1}. "${r.listing.title}" - ${r.listing.location || 'N/A'}`);
    });
    
    if (sydneyCount > 0) {
      if (enforceConstraints) {
        // With enforceConstraints, every result must match Sydney
        if (sydneyCount < result.results.length) {
          console.log(`\n✗ FAIL: ${result.results.length - sydneyCount} results are not Sydney`);
          process.exit(1);
        }
      }
      console.log("\n✓ PASS: Location constraint filtering is working!");
    } else {
      console.log("\n✗ FAIL: No Sydney jobs returned");
      process.exit(1);
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}

test();
