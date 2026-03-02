/**
 * JSON Schema Definitions for LLM Outputs
 * 
 * Centralized schemas for use with OpenAI Responses API (gpt-5)
 * Format: text.format.type = "json_schema" with strict validation
 */

export const JSON_SCHEMAS = {
  /**
   * Edge Case Detector - Screening (Consolidated)
   */
  edgeCaseScreening: {
    name: "edge_case_screening",
    strict: true,
    schema: {
      type: "object",
      properties: {
        analyzable: {
          type: "boolean",
          description: "Whether the response can be analyzed (contains opinions/positions)"
        },
        action: {
          type: "string",
          enum: ["analyze-normally", "analyze-with-context", "no-opinion"],
          description: "How to handle this response"
        },
        referencedNumbers: {
          type: "array",
          items: {
            type: "integer",
            minimum: 1
          },
          description: "List of referenced response numbers (empty array if none)"
        }
      },
      required: ["analyzable", "action", "referencedNumbers"],
      additionalProperties: false
    }
  },

  /**
   * Micro Summarizer - Response Summary
   */
  microSummary: {
    name: "micro_summary",
    strict: true,
    schema: {
      type: "object",
      properties: {
        reasoning: {
          type: "string",
          description: "Step-by-step reasoning for why the response contains the extracted arguments and why it is/is not analyzable"
        },
        responseNumber: {
          type: "integer",
          minimum: 1,
          description: "Response ID number"
        },
        analyzable: {
          type: "boolean",
          description: "Whether response can be analyzed"
        },
        arguments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              what: {
                type: "string",
                description: "What the respondent argues for (concrete position/desire)"
              },
              why: {
                type: "string",
                description: "Why this is important to the respondent (reasoning/motivation)"
              },
              how: {
                type: "string",
                description: "How it should be implemented (concrete suggestions/solutions)"
              },
              consequence: {
                type: "string",
                description: "Overall direction (e.g. 'Desire for...', 'Opposition to...', 'Requirement for...')"
              },
              concern: {
                type: "string",
                description: "What concerns the respondent if not addressed"
              },
              sourceQuote: {
                type: "string",
                description: "Direct quote from the hearing response that supports this argument"
              },
              relevantThemes: {
                type: "array",
                items: {
                  type: "string"
                },
                minItems: 1,
                maxItems: 1,
                description: "EXACTLY ONE relevant theme for this argument - never 0, never 2+"
              },
              substanceRefs: {
                type: "array",
                items: {
                  type: "string"
                },
                description: "IDs of substance items this argument primarily responds to (e.g., ['LP-001']). Empty array if no specific substance."
              },
              directionReasoning: {
                type: "string",
                description: "Kort ræsonnement: Vil respondenten have PRÆCIS det foreslåede gennemført? Hvis alternativt forslag → pro_status_quo"
              },
              direction: {
                type: "string",
                enum: ["pro_change", "pro_status_quo", "neutral"],
                description: "Baseret på directionReasoning: pro_change (støtter forslaget), pro_status_quo (modsætter sig/vil have alternativ), neutral"
              },
              outOfScope: {
                type: "boolean",
                description: "True if this argument falls outside the hearing's scope (e.g., topics not covered by the proposal)"
              }
            },
            required: ["what", "why", "how", "consequence", "concern", "sourceQuote", "relevantThemes", "substanceRefs", "directionReasoning", "direction", "outOfScope"],
            additionalProperties: false
          },
          description: "Structured arguments from the response"
        },
        edgeCaseFlags: {
          type: "object",
          properties: {
            referencesOtherResponses: {
              type: "boolean"
            },
            referencesOtherResponseNumbers: {
              type: "array",
              items: {
                type: "integer"
              }
            },
            incomprehensible: {
              type: "boolean"
            },
            irrelevant: {
              type: "boolean"
            },
            notes: {
              type: "string"
            }
          },
          required: ["referencesOtherResponses", "referencesOtherResponseNumbers", "incomprehensible", "irrelevant", "notes"],
          additionalProperties: false
        }
      },
      required: ["reasoning", "responseNumber", "analyzable", "arguments", "edgeCaseFlags"],
      additionalProperties: false
    }
  },

  /**
   * Theme Extractor - Themes
   */
  themeExtraction: {
    name: "theme_extraction",
    strict: true,
    schema: {
      type: "object",
      properties: {
        documentPurpose: {
          type: "string",
          description: "Purpose of the hearing document"
        },
        documentType: {
          type: "string",
          description: "Type of document (lokalplan, vedtægt, etc)"
        },
        themes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Theme name"
              },
              level: {
                type: "integer",
                minimum: 0,
                description: "Hierarchical level (0 = top level)"
              },
              description: {
                type: "string",
                description: "Brief description of theme"
              },
              category: {
                type: "string",
                enum: ["regulation", "general", "out-of-scope"],
                description: "Category of theme"
              },
              sectionReference: {
                type: ["string", "null"],
                description: "Reference to document section (e.g. § 7)"
              }
            },
            required: ["name", "level", "description", "category", "sectionReference"],
            additionalProperties: false
          },
          description: "Extracted themes"
        },
        outOfScope: {
          type: "object",
          properties: {
            identified: {
              type: "boolean"
            },
            examples: {
              type: "array",
              items: {
                type: "string"
              }
            }
          },
          required: ["identified", "examples"],
          additionalProperties: false
        }
      },
      required: ["documentPurpose", "documentType", "themes", "outOfScope"],
      additionalProperties: false
    }
  },

  /**
   * Taxonomy Generator - Theme Taxonomy
   */
  taxonomy: {
    name: "taxonomy_generation",
    strict: true,
    schema: {
      type: "object",
      properties: {
        themes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Short ID in snake_case (e.g., traffic_noise)"
              },
              name: {
                type: "string",
                description: "Clear, human-readable name of the theme"
              },
              description: {
                type: "string",
                description: "Description of what this theme covers"
              }
            },
            required: ["id", "name", "description"],
            additionalProperties: false
          },
          description: "List of themes defined from the material"
        }
      },
      required: ["themes"],
      additionalProperties: false
    }
  },

  /**
   * Aggregator - Position Groups
   */
  aggregatorPositions: {
    name: "aggregator_positions",
    strict: true,
    schema: {
      type: "object",
      properties: {
        groups: {
          type: "array",
          items: {
            type: "object",
            properties: {
              summary: {
                type: "string",
                description: "Group summary"
              },
              argumentIndices: {
                type: "array",
                items: {
                  type: "integer",
                  minimum: 0
                },
                description: "Indices of arguments in this group"
              },
              responseNumbers: {
                type: "array",
                items: {
                  type: "integer",
                  minimum: 1
                },
                description: "Response numbers in this group"
              },
              respondentBreakdown: {
                type: "object",
                properties: {
                  localCommittees: {
                    type: "array",
                    items: { type: "string" }
                  },
                  publicAuthorities: {
                    type: "array",
                    items: { type: "string" }
                  },
                  organizations: {
                    type: "array",
                    items: { type: "string" }
                  },
                  citizens: {
                    type: "integer",
                    minimum: 0
                  },
                  total: {
                    type: "integer",
                    minimum: 0
                  }
                },
                required: ["localCommittees", "publicAuthorities", "organizations", "citizens", "total"],
                additionalProperties: false
              },
              citationMap: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    highlight: {
                      type: "string",
                      description: "Text from summary to highlight"
                    },
                    responseNumbers: {
                      type: "array",
                      items: {
                        type: "integer",
                        minimum: 1
                      },
                      description: "Response numbers for this highlight"
                    }
                  },
                  required: ["highlight", "responseNumbers"],
                  additionalProperties: false
                },
                description: "Citation mapping for this group"
              }
            },
            required: ["summary", "argumentIndices", "responseNumbers", "respondentBreakdown", "citationMap"],
            additionalProperties: false
          },
          description: "Grouped arguments"
        }
      },
      required: ["groups"],
      additionalProperties: false
    }
  },

  /**
   * Position Consolidator - Merge Validation
   */
  consolidatorMergeValidation: {
    name: "consolidator_merge_validation",
    strict: true,
    schema: {
      type: "object",
      properties: {
        shouldMerge: {
          type: "boolean",
          description: "Whether the two positions should be merged"
        },
        reasoning: {
          type: "string",
          description: "Brief explanation of the decision"
        },
        hasSubArguments: {
          type: "boolean",
          description: "True if merge is recommended but positions have different WHAT/WHY sub-arguments"
        },
        subArgumentTypes: {
          type: "array",
          description: "Categories of sub-arguments if hasSubArguments is true",
          items: {
            type: "string"
          }
        }
      },
      required: ["shouldMerge", "reasoning", "hasSubArguments", "subArgumentTypes"],
      additionalProperties: false
    }
  },

  /**
   * Hybrid Position Writer - Position Draft
   */
  hybridPositionDraft: {
    name: "hybrid_position_draft",
    strict: true,
    schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Descriptive title for the position (inclusive of all respondents in the group)"
        },
        reasoning: {
          type: "string",
          description: "Step-by-step reasoning and self-critique (Perfection Loop) before generating the final summary."
        },
        summary: {
          type: "string",
          description: "Summary text with <<REF_N>> placeholders"
        },
        references: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Reference ID (e.g., REF_1)"
              },
              label: {
                type: "string",
                description: "Label text before placeholder (e.g., 'tre borgere', 'Valby Lokaludvalg')"
              },
              respondents: {
                type: "array",
                items: {
                  type: "integer",
                  minimum: 1
                },
                description: "Response numbers for this reference"
              },
              quotes: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    responseNumber: {
                      type: "integer",
                      minimum: 1
                    },
                    quote: {
                      type: "string"
                    }
                  },
                  required: ["responseNumber", "quote"],
                  additionalProperties: false
                },
                description: "Individual quotes for each respondent (empty if >15 respondents)"
              },
              notes: {
                type: "string",
                description: "Notes or list of response numbers for large groups"
              }
            },
            required: ["id", "label", "respondents", "quotes", "notes"],
            additionalProperties: false
          },
          description: "Citation references"
        },
        warnings: {
          type: "array",
          items: {
            type: "string"
          },
          description: "Warnings"
        }
      },
      required: ["title", "reasoning", "summary", "references", "warnings"],
      additionalProperties: false
    }
  },

  /**
   * Position Quality Validator - Validation Report
   */
  qualityValidationReport: {
    name: "quality_validation_report",
    strict: true,
    schema: {
      type: "object",
      properties: {
        valid: {
          type: "boolean",
          description: "Overall validation result"
        },
        assessment: {
          type: "string",
          description: "Overall assessment of quality"
        },
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: {
                type: "string",
                enum: ["HIGH", "MEDIUM", "LOW"]
              },
              type: {
                type: "string",
                enum: ["UNDER_MERGED", "OVER_MERGED", "CROSS_THEME_REDUNDANCY", "SEMANTIC_IMPRECISION", "MISSING_BREAKDOWN"]
              },
              description: {
                type: "string"
              },
              affectedPositions: {
                type: "array",
                items: {
                  type: "integer",
                  minimum: 1
                }
              }
            },
            required: ["severity", "type", "description", "affectedPositions"],
            additionalProperties: false
          },
          description: "List of validation issues"
        },
        recommendations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["MERGE", "SPLIT", "KEEP"]
              },
              positions: {
                type: "array",
                items: {
                  type: "integer",
                  minimum: 1
                }
              },
              reasoning: {
                type: "string"
              }
            },
            required: ["action", "positions", "reasoning"],
            additionalProperties: false
          },
          description: "Recommendations for improving quality"
        },
        expectedPositionCount: {
          type: ["integer", "null"],
          minimum: 1,
          description: "Expected number of positions based on response count"
        }
      },
      required: ["valid", "assessment", "issues", "recommendations", "expectedPositionCount"],
      additionalProperties: false
    }
  },

  /**
   * Object Extractor - Extract primary objects from arguments
   */
  objectExtraction: {
    name: "object_extraction",
    strict: true,
    schema: {
      type: "object",
      properties: {
        objects: {
          type: "array",
          items: {
            type: "object",
            properties: {
              idx: {
                type: "integer",
                minimum: 0,
                description: "Index of the argument"
              },
              object: {
                type: ["string", "null"],
                description: "Primary object/place (e.g., 'Palads', 'Bygning A', 'vej') or null if no physical object"
              }
            },
            required: ["idx", "object"],
            additionalProperties: false
          },
          description: "Extracted objects for each argument"
        }
      },
      required: ["objects"],
      additionalProperties: false
    }
  },

  /**
   * Position Grouper - Validate hierarchical sub-positions
   */
  hierarchyValidation: {
    name: "hierarchy_validation",
    strict: true,
    schema: {
      type: "object",
      properties: {
        subPositionIndices: {
          type: "array",
          items: {
            type: "integer",
            minimum: 0
          },
          description: "Indices of positions that should be sub-positions of the master"
        },
        reasoning: {
          type: "string",
          description: "Brief explanation of why these positions are sub-positions"
        }
      },
      required: ["subPositionIndices", "reasoning"],
      additionalProperties: false
    }
  },

  /**
   * Sub-Position Extractor - Extract sub-arguments from mega-positions
   */
  subPositionExtraction: {
    name: "sub_position_extraction",
    strict: true,
    schema: {
      type: "object",
      properties: {
        subPositions: {
          type: "array",
          description: "Array of sub-positions identified",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Title of the sub-position"
              },
              what: {
                type: "string",
                description: "What is being requested/opposed (the object/action)"
              },
              why: {
                type: "string",
                description: "Why/reasoning behind this sub-argument"
              },
              how: {
                type: "string",
                description: "How it should be achieved (the method/mechanism)"
              },
              responseNumbers: {
                type: "array",
                description: "Response numbers supporting this sub-argument",
                items: {
                  type: "integer",
                  minimum: 1
                }
              },
              summary: {
                type: "string",
                description: "Brief summary of this sub-argument"
              }
            },
            required: ["title", "what", "why", "how", "responseNumbers", "summary"],
            additionalProperties: false
          }
        },
        masterOnlyRespondents: {
          type: "array",
          description: "Response numbers of respondents who ONLY express the general position without specific nuance/arguments. These should NOT also appear in any subPosition.",
          items: {
            type: "integer",
            minimum: 1
          }
        },
        confidence: {
          type: "number",
          description: "Confidence score for the extraction (0-1)",
          minimum: 0,
          maximum: 1
        }
      },
      required: ["subPositions", "masterOnlyRespondents", "confidence"],
      additionalProperties: false
    }
  },
  
  /**
   * Quote Extraction - For retrying quote extraction
   */
  quoteExtraction: {
    name: "quote_extraction",
    strict: true,
    schema: {
      type: "object",
      properties: {
        quotes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              sourceQuote: {
                type: "string",
                description: "EXACT quote from source text (1-3 sentences) that supports the argument"
              }
            },
            required: ["sourceQuote"],
            additionalProperties: false
          },
          description: "Extracted quotes for each argument"
        }
      },
      required: ["quotes"],
      additionalProperties: false
    }
  },

  /**
   * Grouping Quality Validator - Validates and repairs grouping issues
   */
  groupingQualityReport: {
    name: "grouping_quality_report",
    strict: true,
    schema: {
      type: "object",
      properties: {
        valid: {
          type: "boolean",
          description: "Overall validation result"
        },
        issueCount: {
          type: "integer",
          minimum: 0,
          description: "Total number of issues found"
        },
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["DUPLICATE_CITATION", "REDUNDANT_POSITION", "CROSS_THEME_REDUNDANT", "MICRO_POSITION", "COVERAGE_LOSS"]
              },
              severity: {
                type: "string",
                enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]
              },
              theme: {
                type: ["string", "null"],
                description: "Theme name if applicable"
              },
              description: {
                type: "string",
                description: "Human-readable description of the issue"
              },
              affectedResponseNumbers: {
                type: "array",
                items: {
                  type: "integer",
                  minimum: 1
                },
                description: "Response numbers affected by this issue"
              }
            },
            required: ["type", "severity", "description"],
            additionalProperties: false
          },
          description: "List of detected issues"
        },
        repairs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["DEDUPLICATE_CITATIONS", "MERGE_POSITIONS", "CROSS_THEME_MERGE", "ABSORB_MICRO_POSITION"]
              },
              theme: {
                type: ["string", "null"],
                description: "Theme name if applicable"
              },
              description: {
                type: "string",
                description: "Description of repair applied"
              }
            },
            required: ["action", "description"],
            additionalProperties: false
          },
          description: "List of repairs applied"
        }
      },
      required: ["valid", "issueCount", "issues", "repairs"],
      additionalProperties: false
    }
  },

  /**
   * Position Title Generator - Master-holdning extraction
   */
  positionTitle: {
    name: "position_title",
    strict: true,
    schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "The position title - must start with holdningsmarkør (Ønske om, Modstand mod, etc.) and represent the common minimum holding",
          maxLength: 150
        },
        confidence: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Confidence in the title representing ALL respondents' common holding"
        },
        reasoning: {
          type: "string",
          description: "Brief explanation of why this title represents the common minimum (max 50 words)",
          maxLength: 300
        }
      },
      required: ["title", "confidence", "reasoning"],
      additionalProperties: false
    }
  }
};

/**
 * Helper function to create response_format for OpenAI API calls
 * @param {string} schemaName - Name of schema from JSON_SCHEMAS
 * @returns {Object} response_format object for createCompletion
 */
export function getResponseFormat(schemaName) {
  const schema = JSON_SCHEMAS[schemaName];
  if (!schema) {
    throw new Error(`Unknown schema: ${schemaName}`);
  }

  return {
    type: 'json_schema',
    json_schema: schema
  };
}

