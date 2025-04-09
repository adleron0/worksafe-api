import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CompanyService } from './company.service';
import { CompanyDto } from './dtos/company.dto';

@Controller('company')
export class CompanyController {
  constructor(private companyService: CompanyService) {}

  @Get(':id')
  async getCompany(@Param('id') id: string) {
    return await this.companyService.getCompany(Number(id));
  }

  @Post()
  async createCompany(@Body() company: CompanyDto) {
    return await this.companyService.createCompany(company);
  }
}
