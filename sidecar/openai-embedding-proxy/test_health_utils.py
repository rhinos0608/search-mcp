import unittest

from health_utils import is_embedding_model_available


class HealthUtilsTest(unittest.TestCase):
    def test_detects_lm_studio_embedding_model_alias(self) -> None:
        self.assertTrue(
            is_embedding_model_available(
                expected_model="embeddinggemma-300m",
                openai_model_ids=["text-embedding-embeddinggemma-300m"],
                lmstudio_models=[],
            )
        )

    def test_detects_lm_studio_rest_embedding_model(self) -> None:
        self.assertTrue(
            is_embedding_model_available(
                expected_model="embeddinggemma-300m",
                openai_model_ids=[],
                lmstudio_models=[
                    {
                        "type": "embedding",
                        "key": "embeddinggemma-300m",
                        "display_name": "EmbeddingGemma 300M",
                        "loaded_instances": [
                            {"id": "text-embedding-embeddinggemma-300m"}
                        ],
                    }
                ],
            )
        )

    def test_ignores_non_embedding_models(self) -> None:
        self.assertFalse(
            is_embedding_model_available(
                expected_model="embeddinggemma-300m",
                openai_model_ids=[],
                lmstudio_models=[
                    {
                        "type": "llm",
                        "key": "gemma-4-e2b-it",
                        "display_name": "Gemma 4",
                        "loaded_instances": [{"id": "gemma-4-e2b-it"}],
                    }
                ],
            )
        )


if __name__ == "__main__":
    unittest.main()
