export const redditSearchListingFixture = {
  data: {
    children: [
      {
        kind: 't3',
        data: {
          title: 'TypeScript 5.8 released',
          url: 'https://example.com/typescript-5-8',
          selftext: 'x'.repeat(2005),
          score: 420,
          num_comments: 84,
          subreddit: 'typescript',
          author: 'anders',
          created_utc: 1_710_000_000,
          permalink: '/r/typescript/comments/abc123/typescript_58_released/',
          is_video: false,
        },
      },
      {
        kind: 't3',
        data: {
          title: 'Typed linting pipeline',
          url: 'https://example.com/typed-linting',
          selftext: 'Short body',
          score: 73,
          num_comments: 12,
          subreddit: 'typescript',
          author: 'compilerfan',
          created_utc: 1_710_000_123,
          permalink: '/r/typescript/comments/def456/typed_linting_pipeline/',
          is_video: true,
        },
      },
    ],
  },
};

export const redditCommentsListingFixture = [
  {
    data: {
      children: [
        {
          kind: 't3',
          data: {
            id: 'abc123',
            name: 't3_abc123',
            title: 'Example Post',
            selftext: 'Post body',
            author: 'op',
            subreddit: 'typescript',
            score: 101,
            num_comments: 3,
            created_utc: 1_710_100_000,
            permalink: '/r/typescript/comments/abc123/example_post/',
            url: 'https://example.com/post',
            is_video: false,
          },
        },
      ],
    },
  },
  {
    data: {
      children: [
        {
          kind: 't1',
          data: {
            id: 'c1',
            name: 't1_c1',
            author: 'alice',
            body: 'Top level comment',
            score: 11,
            created_utc: 1_710_100_100,
            permalink: '/r/typescript/comments/abc123/example_post/c1/',
            parent_id: 't3_abc123',
            depth: 0,
            distinguished: null,
            stickied: false,
            collapsed: false,
            replies: {
              data: {
                children: [
                  {
                    kind: 't1',
                    data: {
                      id: 'c2',
                      name: 't1_c2',
                      author: 'bob',
                      body: 'Nested reply',
                      score: 5,
                      created_utc: 1_710_100_200,
                      permalink: '/r/typescript/comments/abc123/example_post/c2/',
                      parent_id: 't1_c1',
                      depth: 1,
                      distinguished: 'moderator',
                      stickied: false,
                      collapsed: false,
                      replies: '',
                    },
                  },
                  {
                    kind: 'more',
                    data: {
                      id: 'more-nested',
                      parent_id: 't1_c1',
                      depth: 1,
                      count: 2,
                      children: ['c3', 'c4'],
                    },
                  },
                ],
              },
            },
          },
        },
        {
          kind: 'more',
          data: {
            id: 'more-top',
            parent_id: 't3_abc123',
            depth: 0,
            count: 1,
            children: ['c5'],
          },
        },
      ],
    },
  },
] as const;
