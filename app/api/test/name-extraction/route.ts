import { NextRequest, NextResponse } from 'next/server';
import { extractNameFromNote, testNameExtraction, getAllPatternDescriptions } from '@/app/lib/name-extractor';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const note = searchParams.get('note');
    const testAll = searchParams.get('testAll');

    // If a specific note is provided, test it
    if (note) {
      console.log(`[Test] Testing note: "${note}"`);
      const result = extractNameFromNote(note);

      return NextResponse.json({
        input: note,
        result,
        success: result.extractedName !== null,
      });
    }

    // If testAll parameter is provided, run all tests
    if (testAll === 'true') {
      console.log('[Test] Running all extraction tests...');
      testNameExtraction();

      return NextResponse.json({
        message: 'Name extraction tests completed. Check server logs for results.',
        patterns: getAllPatternDescriptions(),
        examples: {
          highConfidence: [
            'بأسم: أحمد محمد',
            'باسم - خالد',
            'اسم: سارة',
            'باسم العميل: محمد',
          ],
          mediumConfidence: ['باسم أحمد', 'اسم خالد', 'الاسم عبدالله'],
        },
      });
    }

    // Default response with usage instructions
    return NextResponse.json({
      message: 'Name Extraction Test Endpoint',
      usage: {
        testSingle: '/api/test/name-extraction?note=بأسم: أحمد محمد',
        testAll: '/api/test/name-extraction?testAll=true',
      },
      patterns: getAllPatternDescriptions(),
    });
  } catch (error) {
    console.error('[Test] Endpoint error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
